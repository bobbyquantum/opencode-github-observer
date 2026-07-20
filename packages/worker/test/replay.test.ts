import { describe, expect, it } from "vitest";
import {
  bufferEvent,
  drainReplayBuffer,
  peekReplayBuffer,
  replayKey,
  REPLAY_MAX_PER_REPO,
  REPLAY_TTL_MS,
  type BufferedEvent,
  type ReplayStorage,
} from "../src/replay.js";
import type { ActionableEvent } from "@opencode-observer/shared";

// In-memory KV storage that mimics the DO storage interface.
function makeMemoryStorage(): ReplayStorage & { _store: Map<string, unknown> } {
  const _store = new Map<string, unknown>();
  return {
    _store,
    get: async <T>(key: string): Promise<T | undefined> => _store.get(key) as T | undefined,
    put: async <T>(key: string, value: T): Promise<void> => {
      _store.set(key, value);
    },
  };
}

function makeEvent(repo: string, message: string): ActionableEvent {
  return {
    type: "ci_failure",
    repo,
    repoFullName: repo,
    prNumber: 0,
    prTitle: "",
    headSha: "abc",
    headRef: "feat",
    baseRef: "main",
    message,
    htmlUrl: "https://example.com",
    sender: "bot",
    timestamp: new Date().toISOString(),
  };
}

describe("replay buffer", () => {
  it("replayKey prefixes with 'replay:'", () => {
    expect(replayKey("owner/repo")).toBe("replay:owner/repo");
  });

  it("bufferEvent stores an entry under the repo's key", async () => {
    const s = makeMemoryStorage();
    const ev = makeEvent("owner/repo", "fail-1");
    const result = await bufferEvent(s, "owner/repo", ev, 1000);
    expect(result).toHaveLength(1);
    expect(result[0].event.message).toBe("fail-1");
    expect(s._store.get(replayKey("owner/repo"))).toBeDefined();
  });

  it("bufferEvent evicts expired entries on next buffer", async () => {
    const s = makeMemoryStorage();
    const t0 = 1_000_000;
    // Buffer an event that expires at t0 + TTL.
    await bufferEvent(s, "owner/repo", makeEvent("owner/repo", "old"), t0);
    // Advance well past TTL.
    const future = t0 + REPLAY_TTL_MS + 60_000;
    await bufferEvent(s, "owner/repo", makeEvent("owner/repo", "new"), future);
    const buf = s._store.get(replayKey("owner/repo")) as BufferedEvent[];
    expect(buf).toHaveLength(1);
    expect(buf[0].event.message).toBe("new");
  });

  it("bufferEvent trims to the per-repo cap", async () => {
    const s = makeMemoryStorage();
    const t0 = 1_000_000;
    for (let i = 0; i < REPLAY_MAX_PER_REPO + 5; i++) {
      await bufferEvent(s, "owner/repo", makeEvent("owner/repo", `ev-${i}`), t0);
    }
    const buf = s._store.get(replayKey("owner/repo")) as BufferedEvent[];
    expect(buf).toHaveLength(REPLAY_MAX_PER_REPO);
    // Oldest 5 should be trimmed — first remaining should be ev-5.
    expect(buf[0].event.message).toBe(`ev-5`);
  });

  it("drainReplayBuffer returns fresh events and clears the buffer", async () => {
    const s = makeMemoryStorage();
    await bufferEvent(s, "owner/repo", makeEvent("owner/repo", "a"), 1000);
    await bufferEvent(s, "owner/repo", makeEvent("owner/repo", "b"), 1000);
    const drained = await drainReplayBuffer(s, "owner/repo", 2000);
    expect(drained).toHaveLength(2);
    expect(drained.map((b) => b.event.message).sort()).toEqual(["a", "b"]);
    // Buffer should be empty after drain.
    const remaining = s._store.get(replayKey("owner/repo")) as BufferedEvent[];
    expect(remaining).toEqual([]);
  });

  it("drainReplayBuffer drops expired entries", async () => {
    const s = makeMemoryStorage();
    const t0 = 1_000_000;
    await bufferEvent(s, "owner/repo", makeEvent("owner/repo", "old"), t0);
    const future = t0 + REPLAY_TTL_MS + 60_000;
    const drained = await drainReplayBuffer(s, "owner/repo", future);
    expect(drained).toHaveLength(0);
  });

  it("drainReplayBuffer is a no-op when no buffer exists", async () => {
    const s = makeMemoryStorage();
    const drained = await drainReplayBuffer(s, "owner/repo", 1000);
    expect(drained).toEqual([]);
  });

  it("buffers are scoped per repo", async () => {
    const s = makeMemoryStorage();
    await bufferEvent(s, "owner/repo-a", makeEvent("owner/repo-a", "a1"), 1000);
    await bufferEvent(s, "owner/repo-b", makeEvent("owner/repo-b", "b1"), 1000);
    expect(await drainReplayBuffer(s, "owner/repo-a", 2000)).toHaveLength(1);
    expect(await drainReplayBuffer(s, "owner/repo-b", 2000)).toHaveLength(1);
  });

  it("peekReplayBuffer returns fresh entries without clearing", async () => {
    const s = makeMemoryStorage();
    await bufferEvent(s, "owner/repo", makeEvent("owner/repo", "a"), 1000);
    const peeked = await peekReplayBuffer(s, "owner/repo", 2000);
    expect(peeked).toHaveLength(1);
    const stillThere = s._store.get(replayKey("owner/repo")) as BufferedEvent[];
    expect(stillThere).toHaveLength(1);
  });
});