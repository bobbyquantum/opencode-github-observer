import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, buildPrompt } from "../src/session-manager.js";
import { SessionMap } from "../src/session-map.js";
import { BranchPrCache } from "../src/branch-pr-cache.js";
import { _resetShaMemo } from "../src/github-lookup.js";
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
  vcsInfoForDirectory?: ReturnType<typeof vi.fn>;
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

function makeManager(
  client: MockClient,
  sessionMap: SessionMap,
  repos: Record<string, { workdir: string }> = { "owner/repo": { workdir: "/r/repo" } },
  extra: { branchPrCache?: BranchPrCache; githubToken?: string; cooldownMs?: number } = {},
) {
  const serverManager = {
    ensure: vi.fn(async () => ({ client, url: "http://x" })),
    getClient: vi.fn(() => client),
    stopAll: vi.fn(async () => {}),
  };
  return new SessionManager({ repos, serverManager: serverManager as unknown as never, sessionMap, ...extra });
}

describe("SessionManager", () => {
  let sessionMap: SessionMap;

  beforeEach(() => {
    sessionMap = new SessionMap("/tmp/oco-sm-test.json");
    _resetShaMemo();
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

  it("skips duplicate events within the cooldown window", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", branch: "feature", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => makeSession("s1")),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap, undefined, { cooldownMs: 60_000 });

    // First event: prompts.
    await manager.handleEvent(makeEvent({ prNumber: 5 }));
    expect(client.promptAsync).toHaveBeenCalledTimes(1);

    // Same event type + same PR within cooldown: skipped.
    await manager.handleEvent(makeEvent({ prNumber: 5, message: "another comment" }));
    expect(client.promptAsync).toHaveBeenCalledTimes(1);

    // Different PR: not skipped.
    await manager.handleEvent(makeEvent({ prNumber: 6, message: "different PR" }));
    expect(client.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("skips duplicate ci_failure events on the same branch within cooldown", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", branch: "feat", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => makeSession("s1")),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap, undefined, { cooldownMs: 60_000 });

    await manager.handleEvent(makeEvent({ type: "ci_failure", prNumber: 0, headRef: "feat", headSha: "sha1" }));
    expect(client.promptAsync).toHaveBeenCalledTimes(1);

    // Second CI failure on the same branch within cooldown: skipped.
    await manager.handleEvent(makeEvent({ type: "ci_failure", prNumber: 0, headRef: "feat", headSha: "sha1", message: 'Check "Build" failed' }));
    expect(client.promptAsync).toHaveBeenCalledTimes(1);
  });

  it("enriches ci_failure with PR number from BranchPrCache (no API call)", async () => {
    const branchPrCache = new BranchPrCache("/tmp/oco-bpc-test.json");
    branchPrCache.record("owner/repo", "feat", 42, "sha1");

    sessionMap.record({ sessionID: "s1", repo: "owner/repo", branch: "feat", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => makeSession("s1")),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap, undefined, {
      branchPrCache,
      githubToken: "tok",
    });

    const event = makeEvent({
      type: "ci_failure",
      prNumber: 0,
      prTitle: "",
      headRef: "feat",
      headSha: "sha1",
      message: 'Check "Lint" failed',
    });
    await manager.handleEvent(event);

    // promptAsync should have been called once with the enriched event (PR #42).
    expect(client.promptAsync).toHaveBeenCalledTimes(1);
    const promptArg = client.promptAsync.mock.calls[0][1];
    const promptText = (promptArg.parts[0] as { text: string }).text;
    expect(promptText).toContain("PR #42");
  });

  it("enriches ci_failure via GitHub API fallback and records into cache", async () => {
    const branchPrCache = new BranchPrCache("/tmp/oco-bpc-test2.json");
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify([{ number: 99, head: { ref: "feat/api", sha: "newsha" } }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    sessionMap.record({ sessionID: "s1", repo: "owner/repo", branch: "feat/api", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => makeSession("s1")),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap, undefined, {
      branchPrCache,
      githubToken: "tok",
    });

    // Patch global fetch for this test only.
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await manager.handleEvent(
        makeEvent({
          type: "ci_failure",
          prNumber: 0,
          prTitle: "",
          headRef: "feat/api",
          headSha: "newsha",
          message: 'Check "Lint" failed',
        }),
      );
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(client.promptAsync).toHaveBeenCalledTimes(1);
    const promptText = (client.promptAsync.mock.calls[0][1].parts[0] as { text: string }).text;
    expect(promptText).toContain("PR #99");
    // Cache should now have the resolved mapping.
    expect(branchPrCache.lookupByBranch("owner/repo", "feat/api")?.prNumber).toBe(99);
  });

  it("does not enrich when no cache/token configured (back-compat)", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", branch: "feat", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => makeSession("s1")),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    // No branchPrCache / githubToken passed.
    const manager = makeManager(client, sessionMap);

    await manager.handleEvent(
      makeEvent({ type: "ci_failure", prNumber: 0, prTitle: "", headRef: "feat", headSha: "sha1" }),
    );

    expect(client.promptAsync).toHaveBeenCalledTimes(1);
    // PR #0 should appear as the empty fallback, not enriched.
    const promptText = (client.promptAsync.mock.calls[0][1].parts[0] as { text: string }).text;
    expect(promptText).not.toContain("PR #0");
  });

  it("repromptIfIdle prompts when the session is idle past the threshold", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", prNumber: 42, branch: "feat", headSha: "abc", updatedAt: "t" });
    // Session was last updated 1 hour ago — well past the 30-min threshold.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const client: MockClient = {
      getSession: vi.fn(async () => ({ ...makeSession("s1"), time: { created: 1, updated: oneHourAgo } })),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptIfIdle("owner/repo", 42, "feat", "abc", ["Lint"], 30 * 60 * 1000);
    expect(outcome).toBe("prompted");
    expect(client.promptAsync).toHaveBeenCalledTimes(1);
    const promptText = (client.promptAsync.mock.calls[0][1].parts[0] as { text: string }).text;
    expect(promptText).toContain("watchdog");
    expect(promptText).toContain("Lint");
  });

  it("repromptIfIdle skips when the session was updated recently", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", prNumber: 42, branch: "feat", headSha: "abc", updatedAt: "t" });
    // Session was last updated 1 minute ago — under the 30-min threshold.
    const oneMinuteAgo = Date.now() - 60 * 1000;
    const client: MockClient = {
      getSession: vi.fn(async () => ({ ...makeSession("s1"), time: { created: 1, updated: oneMinuteAgo } })),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptIfIdle("owner/repo", 42, "feat", "abc", ["Lint"], 30 * 60 * 1000);
    expect(outcome).toBe("skipped:idle");
    expect(client.promptAsync).not.toHaveBeenCalled();
  });

  it("repromptIfIdle returns no-session when the session map has no entry", async () => {
    const client: MockClient = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      promptAsync: vi.fn(),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptIfIdle("owner/repo", 999, "feat", "abc", ["Lint"], 30 * 60 * 1000);
    expect(outcome).toBe("skipped:no-session");
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it("repromptIfIdle deletes the session mapping if the session no longer exists", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", prNumber: 42, branch: "feat", headSha: "abc", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => { throw new Error("404"); }),
      createSession: vi.fn(),
      promptAsync: vi.fn(),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptIfIdle("owner/repo", 42, "feat", "abc", ["Lint"], 30 * 60 * 1000);
    expect(outcome).toBe("skipped:no-session");
    expect(sessionMap.getBySession("s1")).toBeUndefined();
  });

  it("repromptForMergeConflict prompts when the session is idle past the threshold", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", prNumber: 42, branch: "feat", headSha: "abc", updatedAt: "t" });
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const client: MockClient = {
      getSession: vi.fn(async () => ({ ...makeSession("s1"), time: { created: 1, updated: oneHourAgo } })),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptForMergeConflict("owner/repo", 42, "feat", "abc", "main", 30 * 60 * 1000);
    expect(outcome).toBe("prompted");
    expect(client.promptAsync).toHaveBeenCalledTimes(1);
    const promptText = (client.promptAsync.mock.calls[0][1].parts[0] as { text: string }).text;
    expect(promptText).toContain("Merge conflict detected");
    expect(promptText).toContain("Rebase your branch on");
    expect(promptText).toContain("main");
    expect(promptText).toContain("resolve the conflicts");
  });

  it("repromptForMergeConflict skips when the session was updated recently", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", prNumber: 42, branch: "feat", headSha: "abc", updatedAt: "t" });
    const oneMinuteAgo = Date.now() - 60 * 1000;
    const client: MockClient = {
      getSession: vi.fn(async () => ({ ...makeSession("s1"), time: { created: 1, updated: oneMinuteAgo } })),
      createSession: vi.fn(),
      promptAsync: vi.fn(),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptForMergeConflict("owner/repo", 42, "feat", "abc", "main", 30 * 60 * 1000);
    expect(outcome).toBe("skipped:idle");
    expect(client.promptAsync).not.toHaveBeenCalled();
  });

  it("repromptForMergeConflict returns no-session when no mapping exists", async () => {
    const client: MockClient = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      promptAsync: vi.fn(),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptForMergeConflict("owner/repo", 999, "feat", "abc", "main", 30 * 60 * 1000);
    expect(outcome).toBe("skipped:no-session");
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it("repromptForMergeConflict uses a separate cooldown from ci_failure", async () => {
    // A merge-conflict prompt should not suppress a subsequent ci_failure
    // prompt for the same PR (different cooldown keys).
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", prNumber: 42, branch: "feat", headSha: "abc", updatedAt: "t" });
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const client: MockClient = {
      getSession: vi.fn(async () => ({ ...makeSession("s1"), time: { created: 1, updated: oneHourAgo } })),
      createSession: vi.fn(),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    // First: merge conflict prompt.
    const outcome1 = await manager.repromptForMergeConflict("owner/repo", 42, "feat", "abc", "main", 30 * 60 * 1000);
    expect(outcome1).toBe("prompted");

    // Second: ci_failure prompt for the same PR — should NOT be in cooldown.
    const outcome2 = await manager.repromptIfIdle("owner/repo", 42, "feat", "abc", ["Lint"], 30 * 60 * 1000);
    expect(outcome2).toBe("prompted");
    expect(client.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("repromptForMergeConflict deletes the session mapping if the session no longer exists", async () => {
    sessionMap.record({ sessionID: "s1", repo: "owner/repo", prNumber: 42, branch: "feat", headSha: "abc", updatedAt: "t" });
    const client: MockClient = {
      getSession: vi.fn(async () => { throw new Error("404"); }),
      createSession: vi.fn(),
      promptAsync: vi.fn(),
      listSessions: vi.fn(),
      messages: vi.fn(),
    };
    const manager = makeManager(client, sessionMap);

    const outcome = await manager.repromptForMergeConflict("owner/repo", 42, "feat", "abc", "main", 30 * 60 * 1000);
    expect(outcome).toBe("skipped:no-session");
    expect(sessionMap.getBySession("s1")).toBeUndefined();
  });

  it("does not match a session already mapped to a different branch even if /vcs reports the event branch", async () => {
    // ses_existing is mapped to branch "feat-a" in the session map.
    sessionMap.record({ sessionID: "ses_existing", repo: "owner/repo", prNumber: 100, branch: "feat-a", headSha: "sha-a", updatedAt: "t" });
    // But the opencode server reports its worktree is now on "feat-b".
    const client: MockClient = {
      getSession: vi.fn(),
      createSession: vi.fn(async () => makeSession("s-new", "/r/repo")),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(async () => [
        { ...makeSession("ses_existing", "/r/repo"), title: "feat-a work" },
      ]),
      messages: vi.fn(),
      vcsInfoForDirectory: vi.fn(async () => ({ branch: "feat-b", default_branch: "main" })),
    };
    const manager = makeManager(client, sessionMap);

    // Event for "feat-b" — should NOT reuse ses_existing.
    await manager.handleEvent(makeEvent({ headRef: "feat-b", prNumber: 200, headSha: "sha-b" }));

    // ses_existing should NOT have been prompted.
    expect(client.promptAsync).not.toHaveBeenCalledWith("ses_existing", expect.anything());
    // A new session should have been created instead.
    expect(client.createSession).toHaveBeenCalled();
  });

  it("rejects a /vcs branch match when the session's first user message is unrelated to the event", async () => {
    // ses_unrelated is on a worktree currently checked out to "feat-b" (/vcs
    // match) but its first user message is about a totally different topic.
    // The daemon should not match it to a feat-b CI failure.
    const client: MockClient = {
      getSession: vi.fn(),
      createSession: vi.fn(async () => makeSession("s-new", "/r/repo")),
      promptAsync: vi.fn(async () => {}),
      listSessions: vi.fn(async () => [
        { ...makeSession("ses_unrelated", "/r/repo"), title: "unrelated topic" },
      ]),
      messages: vi.fn(async () => [
        { info: { id: "m1", sessionID: "ses_unrelated", role: "user" as const, time: { created: 1 } }, parts: [{ id: "p1", sessionID: "ses_unrelated", messageID: "m1", type: "text", text: "Please research home assistant ingress and figure out what we could do" }] },
      ]),
      vcsInfoForDirectory: vi.fn(async () => ({ branch: "feat-b", default_branch: "main" })),
    };
    const manager = makeManager(client, sessionMap);

    await manager.handleEvent(makeEvent({ headRef: "feat-b", prNumber: 200, headSha: "sha-b" }));

    // ses_unrelated should NOT have been prompted — its first user message
    // doesn't mention "feat-b" or "#200".
    expect(client.promptAsync).not.toHaveBeenCalledWith("ses_unrelated", expect.anything());
    // A new session should have been created.
    expect(client.createSession).toHaveBeenCalled();
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
