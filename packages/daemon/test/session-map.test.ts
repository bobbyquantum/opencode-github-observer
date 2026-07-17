import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMap } from "../src/session-map.js";

describe("SessionMap", () => {
  let dir: string;
  let map: SessionMap;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oco-smap-"));
    map = new SessionMap(join(dir, "sessions.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    expect(map.lookup("owner/repo", { branch: "feature" })).toBeUndefined();
    expect(map.list()).toHaveLength(0);
  });

  it("records and looks up by branch", () => {
    map.record({ sessionID: "s1", repo: "owner/repo", branch: "feature", updatedAt: "t" });
    expect(map.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s1");
  });

  it("records and looks up by headSha", () => {
    map.record({ sessionID: "s2", repo: "owner/repo", headSha: "abc", updatedAt: "t" });
    expect(map.lookup("owner/repo", { headSha: "abc" })?.sessionID).toBe("s2");
  });

  it("records and looks up by prNumber", () => {
    map.record({ sessionID: "s3", repo: "owner/repo", prNumber: 7, updatedAt: "t" });
    expect(map.lookup("owner/repo", { prNumber: 7 })?.sessionID).toBe("s3");
  });

  it("merges fields when recording the same session again", () => {
    map.record({ sessionID: "s1", repo: "owner/repo", branch: "feature", updatedAt: "t1" });
    map.record({ sessionID: "s1", repo: "owner/repo", prNumber: 5, updatedAt: "t2" });
    expect(map.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s1");
    expect(map.lookup("owner/repo", { prNumber: 5 })?.sessionID).toBe("s1");
  });

  it("scopes lookups by repo", () => {
    map.record({ sessionID: "s1", repo: "owner/repo", branch: "feature", updatedAt: "t" });
    map.record({ sessionID: "s2", repo: "other/repo", branch: "feature", updatedAt: "t" });
    expect(map.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s1");
    expect(map.lookup("other/repo", { branch: "feature" })?.sessionID).toBe("s2");
  });

  it("deletes a session record", () => {
    map.record({ sessionID: "s1", repo: "owner/repo", branch: "feature", updatedAt: "t" });
    map.delete("s1");
    expect(map.lookup("owner/repo", { branch: "feature" })).toBeUndefined();
  });

  it("persists and reloads", async () => {
    map.record({ sessionID: "s1", repo: "owner/repo", branch: "feature", headSha: "abc", updatedAt: "t" });
    await map.persist();

    const reloaded = new SessionMap(join(dir, "sessions.json"));
    await reloaded.load();
    expect(reloaded.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s1");
    expect(reloaded.lookup("owner/repo", { headSha: "abc" })?.sessionID).toBe("s1");
  });

  it("load is a no-op when no file exists", async () => {
    const fresh = new SessionMap(join(dir, "missing.json"));
    await fresh.load();
    expect(fresh.list()).toHaveLength(0);
  });
});
