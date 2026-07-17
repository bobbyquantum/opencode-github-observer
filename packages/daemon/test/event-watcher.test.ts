import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleEvent, parseBranchFromCommand, type WatcherState } from "../src/event-watcher.js";
import { SessionMap } from "../src/session-map.js";

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeState(): WatcherState {
  const sessionMap = new SessionMap("/tmp/oco-test-smap-unused.json");
  vi.spyOn(sessionMap, "persist").mockResolvedValue(undefined);
  return {
    repo: "owner/repo",
    currentBranch: "feature",
    sessionMap,
  };
}

function toolEvent(sessionID: string, command: string, output: string, status: "completed" | "running" = "completed") {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "p1",
        sessionID,
        messageID: "m1",
        type: "tool",
        callID: "c1",
        tool: "bash",
        state:
          status === "completed"
            ? { status: "completed", input: { command }, output, title: "bash", metadata: {}, time: { start: 1, end: 2 } }
            : { status: "running", input: { command }, time: { start: 1 } },
      },
    },
  };
}

describe("handleEvent", () => {
  let state: WatcherState;

  beforeEach(() => {
    state = makeState();
  });

  it("updates currentBranch on vcs.branch.updated", () => {
    const next = handleEvent({ type: "vcs.branch.updated", properties: { branch: "newbranch" } }, state);
    expect(next).toBe("newbranch");
  });

  it("returns undefined when branch is unchanged", () => {
    const next = handleEvent({ type: "vcs.branch.updated", properties: { branch: "feature" } }, state);
    expect(next).toBeUndefined();
  });

  it("records a mapping on git push using the branch parsed from the command", () => {
    handleEvent(toolEvent("s1", "git push origin feature", "To github.com:owner/repo\n * [new branch] feature -> feature"), state);
    const rec = state.sessionMap.lookup("owner/repo", { branch: "feature" });
    expect(rec?.sessionID).toBe("s1");
  });

  it("falls back to currentBranch when push command has no refspec", () => {
    handleEvent(toolEvent("s1b", "git push", "Everything up-to-date"), state);
    expect(state.sessionMap.lookup("owner/repo", { branch: "feature" })?.sessionID).toBe("s1b");
  });

  it("records prNumber parsed from gh pr create output", () => {
    handleEvent(
      toolEvent("s2", "gh pr create --fill", "remote: Resolving deltas: 100% done\nCreating pull request for feature into main in owner/repo\nhttps://github.com/owner/repo/pull/42"),
      state,
    );
    const rec = state.sessionMap.lookup("owner/repo", { prNumber: 42 });
    expect(rec?.sessionID).toBe("s2");
  });

  it("records headSha when a 40-char sha appears in output", () => {
    const sha = "a".repeat(40);
    handleEvent(toolEvent("s3", "git push origin feature", `To github.com:owner/repo\n ${sha}..${sha}  feature -> feature`), state);
    expect(state.sessionMap.lookup("owner/repo", { headSha: sha })?.sessionID).toBe("s3");
  });

  it("does not record when no branch can be determined", () => {
    state.currentBranch = "";
    handleEvent(toolEvent("s4", "git push", ""), state);
    expect(state.sessionMap.lookup("owner/repo", { branch: "feature" })).toBeUndefined();
  });

  it("ignores non-bash tools", () => {
    handleEvent(
      {
        type: "message.part.updated",
        properties: {
          part: { id: "p", sessionID: "s", messageID: "m", type: "tool", callID: "c", tool: "edit", state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } } },
        },
      },
      state,
    );
    expect(state.sessionMap.list()).toHaveLength(0);
  });

  it("ignores bash tools that are not push/PR-create", () => {
    handleEvent(toolEvent("s5", "git status", "nothing to commit"), state);
    expect(state.sessionMap.list()).toHaveLength(0);
  });

  it("ignores running tools", () => {
    handleEvent(toolEvent("s6", "git push origin feature", "", "running"), state);
    expect(state.sessionMap.list()).toHaveLength(0);
  });

  it("ignores unknown event types", () => {
    expect(handleEvent({ type: "session.created", properties: {} }, state)).toBeUndefined();
  });
});

describe("parseBranchFromCommand", () => {
  it("parses branch from 'git push origin feature'", () => {
    expect(parseBranchFromCommand("git push origin feature")).toBe("feature");
  });
  it("parses branch with -u flag", () => {
    expect(parseBranchFromCommand("git push -u origin feature")).toBe("feature");
  });
  it("parses dst of HEAD:feature refspec", () => {
    expect(parseBranchFromCommand("git push origin HEAD:feature")).toBe("feature");
  });
  it("parses dst of feature:feature refspec", () => {
    expect(parseBranchFromCommand("git push origin feature:feature")).toBe("feature");
  });
  it("strips refs/heads/ prefix", () => {
    expect(parseBranchFromCommand("git push origin refs/heads/feature")).toBe("feature");
  });
  it("returns undefined for bare 'git push'", () => {
    expect(parseBranchFromCommand("git push")).toBeUndefined();
  });
  it("returns undefined for 'git push origin' with no refspec", () => {
    expect(parseBranchFromCommand("git push origin")).toBeUndefined();
  });
  it("returns undefined for non-push commands", () => {
    expect(parseBranchFromCommand("git status")).toBeUndefined();
  });
  it("ignores HEAD as a branch name", () => {
    expect(parseBranchFromCommand("git push origin HEAD")).toBeUndefined();
  });
});
