import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchPrCache } from "../src/branch-pr-cache.js";

describe("BranchPrCache", () => {
  let dir: string;
  let cache: BranchPrCache;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oco-bpc-"));
    cache = new BranchPrCache(join(dir, "branch-pr.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    expect(cache.lookupByBranch("owner/repo", "feat")).toBeUndefined();
    expect(cache.lookupBySha("owner/repo", "abc")).toBeUndefined();
    expect(cache.lookupByPr("owner/repo", 5)).toBeUndefined();
  });

  it("records and looks up by branch", () => {
    cache.record("owner/repo", "feat", 5);
    expect(cache.lookupByBranch("owner/repo", "feat")?.prNumber).toBe(5);
  });

  it("records headSha and looks up by sha", () => {
    cache.record("owner/repo", "feat", 5, "abc123");
    const hit = cache.lookupBySha("owner/repo", "abc123");
    expect(hit?.prNumber).toBe(5);
    expect(hit?.branch).toBe("feat");
  });

  it("reverse-looks up by PR number", () => {
    cache.record("owner/repo", "feat", 5);
    const hit = cache.lookupByPr("owner/repo", 5);
    expect(hit?.branch).toBe("feat");
  });

  it("preserves existing headSha when recording without it", () => {
    cache.record("owner/repo", "feat", 5, "abc");
    cache.record("owner/repo", "feat", 5);
    expect(cache.lookupByBranch("owner/repo", "feat")?.headSha).toBe("abc");
  });

  it("updates headSha when re-recording with a new one", () => {
    cache.record("owner/repo", "feat", 5, "abc");
    cache.record("owner/repo", "feat", 5, "def");
    expect(cache.lookupByBranch("owner/repo", "feat")?.headSha).toBe("def");
  });

  it("scopes lookups by repo", () => {
    cache.record("owner/repo", "feat", 5);
    cache.record("other/repo", "feat", 9);
    expect(cache.lookupByBranch("owner/repo", "feat")?.prNumber).toBe(5);
    expect(cache.lookupByBranch("other/repo", "feat")?.prNumber).toBe(9);
  });

  it("deletes a branch entry", () => {
    cache.record("owner/repo", "feat", 5);
    cache.deleteBranch("owner/repo", "feat");
    expect(cache.lookupByBranch("owner/repo", "feat")).toBeUndefined();
  });

  it("listForRepo returns all branches", () => {
    cache.record("owner/repo", "feat-a", 5);
    cache.record("owner/repo", "feat-b", 6);
    const list = cache.listForRepo("owner/repo");
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.branch).sort()).toEqual(["feat-a", "feat-b"]);
  });

  it("persists and reloads", async () => {
    cache.record("owner/repo", "feat", 5, "abc");
    await cache.persist();

    const reloaded = new BranchPrCache(join(dir, "branch-pr.json"));
    await reloaded.load();
    expect(reloaded.lookupByBranch("owner/repo", "feat")?.prNumber).toBe(5);
    expect(reloaded.lookupByBranch("owner/repo", "feat")?.headSha).toBe("abc");
  });

  it("load is a no-op when no file exists", async () => {
    const fresh = new BranchPrCache(join(dir, "missing.json"));
    await fresh.load();
    expect(fresh.listForRepo("owner/repo")).toHaveLength(0);
  });
});