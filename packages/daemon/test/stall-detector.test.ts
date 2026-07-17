import { describe, expect, it, vi } from "vitest";
import { detectStalls, buildDirectoryHints, type StallConfig } from "../src/stall-detector.js";
import type { OpencodeClient } from "../src/opencode/client.js";

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type FakeSession = { id: string; title: string; directory: string; time: { updated: number } };
type FakeToolState = { status: string; input?: { command?: string }; time?: { start: number } };
type FakePart = { type: string; tool?: string; state?: FakeToolState };
type FakeMessage = { parts: FakePart[] };

function makeClient(opts: {
  sessions?: FakeSession[];
  messages?: Record<string, FakeMessage[]>;
}): OpencodeClient {
  const sessions = opts.sessions ?? [];
  const messages = opts.messages ?? {};
  return {
    listSessions: vi.fn(async () => sessions),
    messages: vi.fn(async (id: string) => messages[id] ?? []),
    abortSession: vi.fn(async () => {}),
    health: vi.fn(async () => ({ healthy: true, version: "1" })),
  } as unknown as OpencodeClient;
}

const baseConfig: StallConfig = {
  thresholdMs: 30 * 60 * 1000,
  directoryHints: [],
  abort: false,
};

describe("detectStalls", () => {
  it("detects a bash tool stuck in running state beyond threshold", async () => {
    const now = Date.now();
    const client = makeClient({
      sessions: [
        { id: "s1", title: "test", directory: "/work/repo", time: { updated: now } },
      ],
      messages: {
        s1: [{
          parts: [{
            type: "tool",
            tool: "bash",
            state: { status: "running", input: { command: "sleep 9999" }, time: { start: now - 60 * 60 * 1000 } },
          }],
        }],
      },
    });
    const result = await detectStalls(client, { ...baseConfig, thresholdMs: 30 * 60 * 1000 });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].stalledTools).toHaveLength(1);
    expect(result.findings[0].stalledTools[0].tool).toBe("bash");
    expect(result.findings[0].stalledTools[0].command).toBe("sleep 9999");
  });

  it("ignores tools running less than the threshold", async () => {
    const now = Date.now();
    const client = makeClient({
      sessions: [{ id: "s1", title: "test", directory: "/r", time: { updated: now } }],
      messages: {
        s1: [{
          parts: [{
            type: "tool",
            tool: "bash",
            state: { status: "running", input: { command: "echo hi" }, time: { start: now - 1000 } },
          }],
        }],
      },
    });
    const result = await detectStalls(client, { ...baseConfig, thresholdMs: 30 * 60 * 1000 });
    expect(result.findings).toHaveLength(0);
  });

  it("ignores completed tools", async () => {
    const now = Date.now();
    const client = makeClient({
      sessions: [{ id: "s1", title: "test", directory: "/r", time: { updated: now } }],
      messages: {
        s1: [{
          parts: [{
            type: "tool",
            tool: "bash",
            state: { status: "completed", input: { command: "echo done" }, output: "done", title: "", metadata: {}, time: { start: now - 999999, end: now } },
          }],
        }],
      },
    });
    const result = await detectStalls(client, baseConfig);
    expect(result.findings).toHaveLength(0);
  });

  it("filters sessions by directory hints", async () => {
    const now = Date.now();
    const longAgo = now - 60 * 60 * 1000;
    const client = makeClient({
      sessions: [
        { id: "s1", title: "match", directory: "/work/myrepo", time: { updated: now } },
        { id: "s2", title: "no match", directory: "/other/place", time: { updated: now } },
      ],
      messages: {
        s1: [{ parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "x" }, time: { start: longAgo } } }] }],
        s2: [{ parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "x" }, time: { start: longAgo } } }] }],
      },
    });
    const result = await detectStalls(client, { ...baseConfig, thresholdMs: 30 * 60 * 1000, directoryHints: ["myrepo"] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].sessionID).toBe("s1");
  });

  it("skips sessions older than 24h", async () => {
    const now = Date.now();
    const client = makeClient({
      sessions: [
        { id: "s1", title: "old", directory: "/r", time: { updated: now - 25 * 60 * 60 * 1000 } },
      ],
      messages: {
        s1: [{ parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "x" }, time: { start: now - 999999 } } }] }],
      },
    });
    const result = await detectStalls(client, baseConfig);
    expect(result.findings).toHaveLength(0);
  });

  it("aborts stalled sessions when abort is true", async () => {
    const now = Date.now();
    const longAgo = now - 60 * 60 * 1000;
    const abortSpy = vi.fn(async () => {});
    const client = makeClient({
      sessions: [{ id: "s1", title: "test", directory: "/r", time: { updated: now } }],
      messages: {
        s1: [{ parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "x" }, time: { start: longAgo } } }] }],
      },
    });
    (client as unknown as { abortSession: typeof abortSpy }).abortSession = abortSpy;
    const result = await detectStalls(client, { ...baseConfig, thresholdMs: 30 * 60 * 1000, abort: true });
    expect(abortSpy).toHaveBeenCalledWith("s1");
    expect(result.aborted).toEqual(["s1"]);
  });
});

describe("buildDirectoryHints", () => {
  it("includes workdir and repo name", () => {
    const hints = buildDirectoryHints({ "owner/repo": { workdir: "/code/repo" } });
    expect(hints).toContain("/code/repo");
    expect(hints).toContain("repo");
  });

  it("includes opencode worktree base path", () => {
    const hints = buildDirectoryHints({});
    expect(hints.some((h) => h.includes("opencode/worktree"))).toBe(true);
  });
});