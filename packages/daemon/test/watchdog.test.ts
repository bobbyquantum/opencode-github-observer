import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchPrCache } from "../src/branch-pr-cache.js";
import {
  fetchOpenPrs,
  fetchFailingChecks,
  fetchPrDetail,
  findFailingPrs,
  isPrEntryFresh,
  isPrUnmergable,
  isPrConflicted,
  DEFAULT_WATCHDOG_CONFIG,
  type WatchdogConfig,
} from "../src/watchdog.js";

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const path = typeof url === "string" ? url : url.toString();
    for (const [route, body] of Object.entries(routes)) {
      if (path.includes(route)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as unknown as typeof fetch;
}

describe("isPrEntryFresh", () => {
  it("returns true for entries updated recently", () => {
    const now = Date.parse("2026-07-20T12:00:00Z");
    const recent = new Date(now - 60_000).toISOString();
    expect(isPrEntryFresh(recent, now, 60 * 60 * 1000)).toBe(true);
  });

  it("returns false for entries older than maxAgeMs", () => {
    const now = Date.parse("2026-07-20T12:00:00Z");
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(isPrEntryFresh(old, now, 7 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it("returns false for unparseable timestamps", () => {
    expect(isPrEntryFresh("not-a-date", Date.now(), 1000)).toBe(false);
  });
});

describe("fetchOpenPrs", () => {
  it("fetches open PRs from /pulls?state=open", async () => {
    const prs = [{ number: 1, head: { ref: "feat", sha: "abc" } }];
    const fetchFn = mockFetch({
      "/pulls?state=open": prs,
    });
    const result = await fetchOpenPrs("owner/repo", "tok", 30, { fetch: fetchFn });
    expect(result).toEqual(prs);
  });

  it("truncates to maxPrs", async () => {
    const prs = Array.from({ length: 50 }, (_, i) => ({ number: i + 1, head: { ref: `b${i}`, sha: `s${i}` } }));
    const fetchFn = mockFetch({ "/pulls?state=open": prs });
    const result = await fetchOpenPrs("owner/repo", "tok", 10, { fetch: fetchFn });
    expect(result).toHaveLength(10);
  });

  it("throws on non-OK response", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchOpenPrs("owner/repo", "tok", 30, { fetch: fetchFn })).rejects.toThrow();
  });
});

describe("fetchFailingChecks", () => {
  it("returns deduplicated failing check names for the given sha", async () => {
    const checkRuns = {
      check_runs: [
        { name: "Lint", conclusion: "failure", head_sha: "abc123" },
        { name: "Lint", conclusion: "failure", head_sha: "abc123" }, // dup
        { name: "Build", conclusion: "success", head_sha: "abc123" },
        { name: "Test", conclusion: "failure", head_sha: "different" }, // different sha
      ],
    };
    const fetchFn = mockFetch({ "/commits/abc123/check-runs": checkRuns });
    const result = await fetchFailingChecks("owner/repo", "abc123", "tok", { fetch: fetchFn });
    expect(result).toEqual(["Lint"]);
  });

  it("returns empty array when no failures", async () => {
    const checkRuns = { check_runs: [{ name: "Build", conclusion: "success", head_sha: "abc" }] };
    const fetchFn = mockFetch({ "/commits/abc/check-runs": checkRuns });
    const result = await fetchFailingChecks("owner/repo", "abc", "tok", { fetch: fetchFn });
    expect(result).toEqual([]);
  });

  it("throws on non-OK response", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchFailingChecks("owner/repo", "abc", "tok", { fetch: fetchFn })).rejects.toThrow();
  });
});

describe("findFailingPrs", () => {
  let dir: string;
  let cache: BranchPrCache;
  const config: WatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG, prMaxAgeMs: 7 * 24 * 60 * 60 * 1000 };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oco-wd-"));
    cache = new BranchPrCache(join(dir, "branch-pr.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a failing PR with a fresh session mapping in failingPrs", async () => {
    cache.record("owner/repo", "feat", 42, "abc123");
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/commits/abc123/check-runs": { check_runs: [{ name: "Lint", conclusion: "failure", head_sha: "abc123" }] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.failingPrs).toHaveLength(1);
    expect(result.failingPrs[0].prNumber).toBe(42);
    expect(result.failingPrs[0].failNames).toEqual(["Lint"]);
    expect(result.unmappedPrs).toHaveLength(0);
  });

  it("reports a failing PR with no session mapping in unmappedPrs", async () => {
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 99, head: { ref: "new", sha: "newsha" } }],
      "/commits/newsha/check-runs": { check_runs: [{ name: "Test", conclusion: "failure", head_sha: "newsha" }] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.failingPrs).toHaveLength(0);
    expect(result.unmappedPrs).toHaveLength(1);
    expect(result.unmappedPrs[0].prNumber).toBe(99);
  });

  it("skips PRs whose cache entry is stale", async () => {
    // Record a PR with an old updatedAt that exceeds prMaxAgeMs.
    cache.record("owner/repo", "feat", 42, "abc123");
    await cache.persist();
    // Manually backdate the entry.
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(dir, "branch-pr.json"), "utf-8"));
    raw["owner/repo"]["feat"].updatedAt = "2020-01-01T00:00:00Z";
    await writeFile(join(dir, "branch-pr.json"), JSON.stringify(raw));
    await cache.load();

    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/commits/abc123/check-runs": { check_runs: [{ name: "Lint", conclusion: "failure", head_sha: "abc123" }] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.failingPrs).toHaveLength(0);
    expect(result.unmappedPrs).toHaveLength(0); // not unmapped either — just stale, skipped
  });

  it("skips PRs that are not failing CI", async () => {
    cache.record("owner/repo", "feat", 42, "abc123");
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/commits/abc123/check-runs": { check_runs: [{ name: "Build", conclusion: "success", head_sha: "abc123" }] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.failingPrs).toHaveLength(0);
    expect(result.unmappedPrs).toHaveLength(0);
  });

  it("returns empty results when fetchOpenPrs fails", async () => {
    const fetchFn = vi.fn(async () => new Response("server down", { status: 500 })) as unknown as typeof fetch;
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.failingPrs).toEqual([]);
    expect(result.unmappedPrs).toEqual([]);
    expect(result.conflictingPrs).toEqual([]);
  });

  it("reports a conflicting PR with a fresh session mapping in conflictingPrs", async () => {
    cache.record("owner/repo", "feat", 42, "abc123");
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/pulls/42": { number: 42, head: { ref: "feat", sha: "abc123" }, mergeable_state: "conflicted", base: { ref: "main" } },
      "/commits/abc123/check-runs": { check_runs: [{ name: "Build", conclusion: "success", head_sha: "abc123" }] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.conflictingPrs).toHaveLength(1);
    expect(result.conflictingPrs[0].prNumber).toBe(42);
    expect(result.conflictingPrs[0].branch).toBe("feat");
    expect(result.conflictingPrs[0].baseRef).toBe("main");
    // No CI failures, so no failingPrs.
    expect(result.failingPrs).toHaveLength(0);
    expect(result.unmappedPrs).toHaveLength(0);
  });

  it("does not add conflicted PRs without a session mapping to conflictingPrs or unmappedPrs", async () => {
    // No cache entry for PR 99 — conflicted but unmapped. The daemon can't
    // prompt a session that doesn't exist, so it's skipped silently (not
    // added to unmappedPrs, which is for CI failures only). Also, the
    // watchdog doesn't fetch PR detail for unmapped PRs (no cache entry to
    // check against), so no /pulls/99 call is made.
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 99, head: { ref: "new", sha: "newsha" } }],
      "/commits/newsha/check-runs": { check_runs: [] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.conflictingPrs).toHaveLength(0);
    expect(result.unmappedPrs).toHaveLength(0);
  });

  it("skips conflicted PRs whose cache entry is stale", async () => {
    cache.record("owner/repo", "feat", 42, "abc123");
    await cache.persist();
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(dir, "branch-pr.json"), "utf-8"));
    raw["owner/repo"]["feat"].updatedAt = "2020-01-01T00:00:00Z";
    await writeFile(join(dir, "branch-pr.json"), JSON.stringify(raw));
    await cache.load();

    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/pulls/42": { number: 42, head: { ref: "feat", sha: "abc123" }, mergeable_state: "conflicted", base: { ref: "main" } },
      "/commits/abc123/check-runs": { check_runs: [] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.conflictingPrs).toHaveLength(0);
  });

  it("skips PRs that are behind but not conflicted or dirty", async () => {
    // "behind" means the base has moved ahead but there are no conflicts —
    // a rebase would be nice but isn't required. Only "conflicted" and
    // "dirty" are actionable.
    cache.record("owner/repo", "feat", 42, "abc123");
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/pulls/42": { number: 42, head: { ref: "feat", sha: "abc123" }, mergeable_state: "behind", base: { ref: "main" } },
      "/commits/abc123/check-runs": { check_runs: [] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.conflictingPrs).toHaveLength(0);
  });

  it("reports a dirty PR as conflicting (dirty = unmergable, needs rebase)", async () => {
    // "dirty" means the PR's own commits conflict with the base — the branch
    // can't merge cleanly and needs intervention. Treat it the same as
    // "conflicted".
    cache.record("owner/repo", "feat", 42, "abc123");
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/pulls/42": { number: 42, head: { ref: "feat", sha: "abc123" }, mergeable_state: "dirty", base: { ref: "main" } },
      "/commits/abc123/check-runs": { check_runs: [] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.conflictingPrs).toHaveLength(1);
    expect(result.conflictingPrs[0].prNumber).toBe(42);
    expect(result.conflictingPrs[0].baseRef).toBe("main");
  });

  it("a PR can be both conflicted and failing CI", async () => {
    // A PR with a merge conflict AND failing checks should appear in both
    // conflictingPrs and failingPrs so the session gets both prompts.
    cache.record("owner/repo", "feat", 42, "abc123");
    const fetchFn = mockFetch({
      "/pulls?state=open": [{ number: 42, head: { ref: "feat", sha: "abc123" } }],
      "/pulls/42": { number: 42, head: { ref: "feat", sha: "abc123" }, mergeable_state: "conflicted", base: { ref: "main" } },
      "/commits/abc123/check-runs": { check_runs: [{ name: "Lint", conclusion: "failure", head_sha: "abc123" }] },
    });
    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(result.conflictingPrs).toHaveLength(1);
    expect(result.failingPrs).toHaveLength(1);
  });

  it("retries fetchPrDetail when the first call returns 'unknown'", async () => {
    // GitHub returns "unknown" on the first call while it computes
    // mergeability asynchronously. The watchdog should retry once.
    cache.record("owner/repo", "feat", 42, "abc123");
    let detailCallCount = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const path = typeof url === "string" ? url : url.toString();
      if (path.includes("/pulls?state=open")) {
        return new Response(JSON.stringify([{ number: 42, head: { ref: "feat", sha: "abc123" } }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path.includes("/pulls/42")) {
        detailCallCount++;
        const state = detailCallCount === 1 ? "unknown" : "conflicted";
        return new Response(JSON.stringify({ number: 42, head: { ref: "feat", sha: "abc123" }, mergeable_state: state, base: { ref: "main" } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (path.includes("/commits/abc123/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await findFailingPrs("owner/repo", "tok", cache, config, { fetch: fetchFn });
    expect(detailCallCount).toBe(2); // retried once
    expect(result.conflictingPrs).toHaveLength(1);
  });
});

describe("isPrUnmergable (alias: isPrConflicted)", () => {
  it("returns true for 'conflicted' (base moved ahead, rebase needed)", () => {
    expect(isPrUnmergable("conflicted")).toBe(true);
  });

  it("returns true for 'dirty' (PR's own commits conflict with base)", () => {
    expect(isPrUnmergable("dirty")).toBe(true);
  });

  it("returns false for 'behind' (needs rebase but no conflicts)", () => {
    expect(isPrUnmergable("behind")).toBe(false);
  });

  it("returns false for 'blocked' (failing required checks)", () => {
    expect(isPrUnmergable("blocked")).toBe(false);
  });

  it("returns false for 'clean' (mergeable, no action needed)", () => {
    expect(isPrUnmergable("clean")).toBe(false);
  });

  it("returns false for 'unstable' (failing checks but mergeable)", () => {
    expect(isPrUnmergable("unstable")).toBe(false);
  });

  it("returns false for null / undefined / 'unknown'", () => {
    expect(isPrUnmergable(null)).toBe(false);
    expect(isPrUnmergable(undefined)).toBe(false);
    expect(isPrUnmergable("unknown")).toBe(false);
  });

  it("isPrConflicted is an alias for isPrUnmergable", () => {
    expect(isPrConflicted).toBe(isPrUnmergable);
    expect(isPrConflicted("dirty")).toBe(true);
    expect(isPrConflicted("conflicted")).toBe(true);
  });
});

describe("fetchPrDetail", () => {
  it("fetches a single PR's full data from /pulls/{number}", async () => {
    const pr = { number: 42, head: { ref: "feat", sha: "abc" }, mergeable_state: "conflicted", base: { ref: "main" } };
    const fetchFn = mockFetch({ "/pulls/42": pr });
    const result = await fetchPrDetail("owner/repo", 42, "tok", { fetch: fetchFn });
    expect(result).toEqual(pr);
    expect(result.mergeable_state).toBe("conflicted");
  });

  it("throws on non-OK response", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchPrDetail("owner/repo", 42, "tok", { fetch: fetchFn })).rejects.toThrow();
  });
});