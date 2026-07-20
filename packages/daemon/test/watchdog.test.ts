import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchPrCache } from "../src/branch-pr-cache.js";
import {
  fetchOpenPrs,
  fetchFailingChecks,
  findFailingPrs,
  isPrEntryFresh,
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
  });
});