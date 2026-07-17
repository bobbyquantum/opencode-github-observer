import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, buildPrompt } from "../src/session-manager.js";
import { SessionMap } from "../src/session-map.js";
import type { ActionableEvent } from "@opencode-observer/shared";
import type { Session, Message } from "../src/opencode/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type MockClient = {
  getSession: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  promptAsync: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  messages: ReturnType<typeof vi.fn>;
};

function makeSession(id: string, dir = "/r/repo"): Session {
  return { id, projectID: "p", directory: dir, title: "t", version: "1", time: { created: 1, updated: 1 } };
}

function makeEvent(overrides: Partial<ActionableEvent> = {}): ActionableEvent {
  return {
    type: "review_comment",
    repo: "owner/repo",
    repoFullName: "owner/repo",
    prNumber: 5,
    prTitle: "Fix thing",
    headSha: "abc123",
    headRef: "feature",
    baseRef: "main",
    message: "please fix",
    htmlUrl: "https://github.com/owner/repo/pull/5",
    sender: "reviewer",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeManager(client: MockClient, sessionMap: SessionMap, repos: Record<string, { workdir: string }> = { "owner/repo": { workdir: "/r/repo" } }) {
  const serverManager = {
    ensure: vi.fn(async () => ({ client, url: "http://x" })),
    getClient: vi.fn(() => client),
    stopAll: vi.fn(async () => {}),
  };
  return new SessionManager({ repos, serverManager: serverManager as unknown as never, sessionMap });
}

describe("SessionManager", () => {
  let sessionMap: SessionMap;

  beforeEach(() => {
    sessionMap = new SessionMap("/tmp/oco-sm-test.json");
  });

  it("resumes a session found in the map and does not create one", async () => {
    sessionMap.record({ sessionID: "s-existing", repo: "owner/repo", branch: "feature", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => makeSession("s-existing")),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    await manager.handleEvent(makeEvent());

    expect(client.getSession).toHaveBeenCalledWith("s-existing");
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.promptAsync).toHaveBeenCalledWith("s-existing", {
      parts: [{ type: "text", text: buildPrompt(makeEvent()) }],
    });
  });

  it("falls back to searching sessions when the map misses", async () => {
    const client: MockClient = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(async () => [makeSession("s-found", "/r/repo")]),
      messages: vi.fn(async () => [
        { info: { id: "m", sessionID: "s-found", role: "user", time: { created: 1 } }, parts: [{ id: "p", sessionID: "s-found", messageID: "m", type: "text", text: "working on feature branch" }] },
      ] as Message[]),
    };
    const manager = makeManager(client, sessionMap);

    await manager.handleEvent(makeEvent({ headRef: "feature" }));

    expect(client.listSessions).toHaveBeenCalled();
    expect(client.promptAsync).toHaveBeenCalledWith("s-found", expect.anything());
    expect(sessionMap.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s-found");
  });

  it("creates a new session when nothing matches", async () => {
    const client: MockClient = {
      getSession: vi.fn(),
      createSession: vi.fn(async () => makeSession("s-new")),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    await manager.handleEvent(makeEvent());

    expect(client.createSession).toHaveBeenCalled();
    expect(client.promptAsync).toHaveBeenCalledWith("s-new", expect.anything());
    expect(sessionMap.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s-new");
  });

  it("creates a new session when the mapped one no longer exists", async () => {
    sessionMap.record({ sessionID: "s-gone", repo: "owner/repo", branch: "feature", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => {
        throw new Error("404");
      }),
      createSession: vi.fn(async () => makeSession("s-new")),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(async () => []),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    await manager.handleEvent(makeEvent());

    expect(client.createSession).toHaveBeenCalled();
    expect(sessionMap.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s-new");
    expect(sessionMap.getBySession("s-gone")).toBeUndefined();
  });

  it("skips events for repos with no configured workdir", async () => {
    const client: MockClient = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      promptAsync: vi.fn(),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap, {});

    await manager.handleEvent(makeEvent());

    expect(client.promptAsync).not.toHaveBeenCalled();
  });

  it("records prNumber on the mapping when known", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", branch: "feature", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => makeSession("s1")),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    await manager.handleEvent(makeEvent({ prNumber: 9 }));

    expect(sessionMap.lookup("owner/repo", { prNumber: 9 })?.sessionID).toBe("s1");
  });
});

describe("buildPrompt", () => {
  it("mentions the branch and PR", () => {
    const prompt = buildPrompt(makeEvent());
    expect(prompt).toContain("feature");
    expect(prompt).toContain("PR #5");
    expect(prompt).toContain("push a fix");
  });

  it("omits branch line when headRef is empty", () => {
    const prompt = buildPrompt(makeEvent({ headRef: "", prNumber: 0 }));
    expect(prompt).not.toContain("Branch:");
    expect(prompt).toContain("Investigate this and push a fix.");
  });
});
