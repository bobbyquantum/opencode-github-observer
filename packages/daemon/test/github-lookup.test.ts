import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchPrCache } from "../src/branch-pr-cache.js";
import { resolvePrForSha, resolvePrByNumber, fetchPrForSha, _resetShaMemo } from "../src/github-lookup.js";

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const PR_PAYLOAD = [{ number: 42, head: { ref: "feat/x", sha: "abc123" } }];

function mockFetch(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("github-lookup", () => {
  let dir: string;
  let cache: BranchPrCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oco-gl-"));
    cache = new BranchPrCache(join(dir, "branch-pr.json"));
    _resetShaMemo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    _resetShaMemo();
  });

  it("returns from cache by sha without hitting the API", async () => {
    cache.record("owner/repo", "feat", 5, "abc");
    const fetchFn = vi.fn();
    const result = await resolvePrForSha("owner/repo", "abc", "feat", "tok", cache, { fetch: fetchFn as typeof fetch });
    expect(result?.prNumber).toBe(5);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns from cache by branch hint when sha is unknown", async () => {
    cache.record("owner/repo", "feat", 5);
    const fetchFn = vi.fn();
    const result = await resolvePrForSha("owner/repo", "newsha", "feat", "tok", cache, { fetch: fetchFn as typeof fetch });
    expect(result?.prNumber).toBe(5);
    expect(result?.headSha).toBe("newsha");
    expect(fetchFn).not.toHaveBeenCalled();
    // Cache should now have the sha recorded for next time.
    expect(cache.lookupBySha("owner/repo", "newsha")?.prNumber).toBe(5);
  });

  it("falls back to GitHub API and records into cache", async () => {
    const fetchFn = mockFetch(PR_PAYLOAD);
    const result = await resolvePrForSha("owner/repo", "abc123", "feat/x", "tok", cache, { fetch: fetchFn });
    expect(result?.prNumber).toBe(42);
    expect(result?.branch).toBe("feat/x");
    // Cache should now be populated.
    expect(cache.lookupByBranch("owner/repo", "feat/x")?.prNumber).toBe(42);
    expect(cache.lookupBySha("owner/repo", "abc123")?.prNumber).toBe(42);
  });

  it("returns null when GitHub API finds no PR", async () => {
    const fetchFn = mockFetch([], 200);
    const result = await resolvePrForSha("owner/repo", "abc", "feat", "tok", cache, { fetch: fetchFn });
    expect(result).toBeNull();
  });

  it("returns null on 404 without warning", async () => {
    const fetchFn = mockFetch({ message: "Not found" }, 404);
    const result = await resolvePrForSha("owner/repo", "abc", "feat", "tok", cache, { fetch: fetchFn });
    expect(result).toBeNull();
  });

  it("uses in-process memo on repeated calls for the same sha", async () => {
    const fetchFn = mockFetch(PR_PAYLOAD);
    await fetchPrForSha("owner/repo", "abc123", "tok", { fetch: fetchFn });
    await fetchPrForSha("owner/repo", "abc123", "tok", { fetch: fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePrByNumber", () => {
  let dir: string;
  let cache: BranchPrCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oco-gl2-"));
    cache = new BranchPrCache(join(dir, "branch-pr.json"));
    _resetShaMemo();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    _resetShaMemo();
  });

  it("returns from cache by PR number without hitting the API", async () => {
    cache.record("owner/repo", "feat", 42, "abc");
    const fetchFn = vi.fn();
    const result = await resolvePrByNumber("owner/repo", 42, "tok", cache, { fetch: fetchFn as typeof fetch });
    expect(result?.prNumber).toBe(42);
    expect(result?.branch).toBe("feat");
    expect(result?.headSha).toBe("abc");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to GitHub API and records into cache", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ number: 99, head: { ref: "feat/api", sha: "newsha" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const result = await resolvePrByNumber("owner/repo", 99, "tok", cache, { fetch: fetchFn });
    expect(result?.prNumber).toBe(99);
    expect(result?.branch).toBe("feat/api");
    expect(result?.headSha).toBe("newsha");
    // Cache should now have the resolved mapping.
    expect(cache.lookupByBranch("owner/repo", "feat/api")?.prNumber).toBe(99);
    expect(cache.lookupBySha("owner/repo", "newsha")?.prNumber).toBe(99);
  });

  it("returns null when GitHub API 404s", async () => {
    const fetchFn = vi.fn(async () =>
      new Response('{"message":"Not Found"}', { status: 404 }),
    ) as unknown as typeof fetch;
    const result = await resolvePrByNumber("owner/repo", 9999, "tok", cache, { fetch: fetchFn });
    expect(result).toBeNull();
  });

  it("returns null when PR number is 0", async () => {
    const fetchFn = vi.fn();
    const result = await resolvePrByNumber("owner/repo", 0, "tok", cache, { fetch: fetchFn as typeof fetch });
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});