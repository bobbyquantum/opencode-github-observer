import { describe, it, expect } from "vitest";
import {
  isClientMessage,
  isServerMessage,
  validateConfig,
  DEFAULT_CONFIG,
} from "../src/index.js";
import type {
  ActionableEvent,
  GitHubCheckRunEvent,
  GitHubPullRequestReviewCommentEvent,
  GitHubPullRequestReviewEvent,
} from "../src/index.js";

describe("protocol", () => {
  describe("isClientMessage", () => {
    it("accepts auth message", () => {
      expect(isClientMessage({ kind: "auth", token: "abc" })).toBe(true);
    });

    it("accepts subscribe message", () => {
      expect(isClientMessage({ kind: "subscribe", repos: ["owner/repo"] })).toBe(true);
    });

    it("accepts unsubscribe message", () => {
      expect(isClientMessage({ kind: "unsubscribe", repos: ["owner/repo"] })).toBe(true);
    });

    it("accepts ping message", () => {
      expect(isClientMessage({ kind: "ping" })).toBe(true);
    });

    it("rejects unknown kind", () => {
      expect(isClientMessage({ kind: "unknown" })).toBe(false);
    });

    it("rejects null", () => {
      expect(isClientMessage(null)).toBe(false);
    });

    it("rejects non-object", () => {
      expect(isClientMessage("string")).toBe(false);
    });

    it("rejects missing kind", () => {
      expect(isClientMessage({ token: "abc" })).toBe(false);
    });
  });

  describe("isServerMessage", () => {
    it("accepts connected message", () => {
      expect(isServerMessage({ kind: "connected", sessionId: "123" })).toBe(true);
    });

    it("accepts event message", () => {
      const event: ActionableEvent = {
        type: "ci_failure",
        repo: "owner/repo",
        repoFullName: "owner/repo",
        prNumber: 1,
        prTitle: "Test PR",
        headSha: "abc123",
        headRef: "feature",
        baseRef: "main",
        message: "CI failed",
        htmlUrl: "https://github.com/owner/repo/actions/1",
        sender: "user",
        timestamp: new Date().toISOString(),
      };
      expect(isServerMessage({ kind: "event", event, repo: "owner/repo" })).toBe(true);
    });

    it("accepts error message", () => {
      expect(isServerMessage({ kind: "error", message: "fail" })).toBe(true);
    });

    it("accepts pong message", () => {
      expect(isServerMessage({ kind: "pong" })).toBe(true);
    });

    it("rejects client messages", () => {
      expect(isServerMessage({ kind: "auth", token: "abc" })).toBe(false);
    });

    it("rejects null", () => {
      expect(isServerMessage(null)).toBe(false);
    });
  });
});

describe("config", () => {
  describe("validateConfig", () => {
    it("returns defaults for empty object", () => {
      const config = validateConfig({});
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it("accepts valid serverUrl", () => {
      const config = validateConfig({ serverUrl: "wss://example.com/ws" });
      expect(config.serverUrl).toBe("wss://example.com/ws");
    });

    it("rejects invalid serverUrl", () => {
      expect(() => validateConfig({ serverUrl: "not-a-url" })).toThrow("valid URL");
    });

    it("rejects non-string serverUrl", () => {
      expect(() => validateConfig({ serverUrl: 123 })).toThrow("must be a string");
    });

    it("accepts valid githubClientId", () => {
      const config = validateConfig({ githubClientId: "client123" });
      expect(config.githubClientId).toBe("client123");
    });

    it("rejects non-string githubClientId", () => {
      expect(() => validateConfig({ githubClientId: 123 })).toThrow("must be a string");
    });

    it("accepts valid logLevel", () => {
      const config = validateConfig({ logLevel: "debug" });
      expect(config.logLevel).toBe("debug");
    });

    it("rejects invalid logLevel", () => {
      expect(() => validateConfig({ logLevel: "invalid" })).toThrow("must be one of");
    });

    it("accepts valid reconnectIntervalMs", () => {
      const config = validateConfig({ reconnectIntervalMs: 5000 });
      expect(config.reconnectIntervalMs).toBe(5000);
    });

    it("rejects non-integer reconnectIntervalMs", () => {
      expect(() => validateConfig({ reconnectIntervalMs: 1.5 })).toThrow("positive integer");
    });

    it("rejects negative reconnectIntervalMs", () => {
      expect(() => validateConfig({ reconnectIntervalMs: -1 })).toThrow("positive integer");
    });

    it("rejects non-object input", () => {
      expect(() => validateConfig(null)).toThrow("must be an object");
      expect(() => validateConfig("string")).toThrow("must be an object");
    });
  });
});

describe("event types", () => {
  it("GitHubCheckRunEvent has correct shape", () => {
    const event: GitHubCheckRunEvent = {
      action: "completed",
      check_run: {
        id: 1,
        name: "CI",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/owner/repo/runs/1",
        head_sha: "abc123",
      },
      repository: {
        id: 1,
        name: "repo",
        full_name: "owner/repo",
        owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
        private: false,
        html_url: "https://github.com/owner/repo",
      },
      sender: { id: 1, login: "owner", avatar_url: "", html_url: "" },
    };
    expect(event.action).toBe("completed");
    expect(event.check_run.conclusion).toBe("failure");
  });

  it("GitHubPullRequestReviewCommentEvent has correct shape", () => {
    const event: GitHubPullRequestReviewCommentEvent = {
      action: "created",
      comment: {
        id: 1,
        body: "Please fix this",
        path: "src/index.ts",
        line: 42,
        html_url: "https://github.com/owner/repo/pull/1#discussion_r1",
        user: { id: 1, login: "reviewer", avatar_url: "", html_url: "" },
      },
      pull_request: {
        number: 1,
        title: "Fix bug",
        head: {
          sha: "abc123",
          ref: "fix-branch",
          repo: {
            id: 1,
            name: "repo",
            full_name: "owner/repo",
            owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
            private: false,
            html_url: "https://github.com/owner/repo",
          },
        },
        base: {
          ref: "main",
          repo: {
            id: 1,
            name: "repo",
            full_name: "owner/repo",
            owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
            private: false,
            html_url: "https://github.com/owner/repo",
          },
        },
        user: { id: 2, login: "author", avatar_url: "", html_url: "" },
        html_url: "https://github.com/owner/repo/pull/1",
      },
      repository: {
        id: 1,
        name: "repo",
        full_name: "owner/repo",
        owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
        private: false,
        html_url: "https://github.com/owner/repo",
      },
      sender: { id: 1, login: "reviewer", avatar_url: "", html_url: "" },
    };
    expect(event.comment.body).toBe("Please fix this");
    expect(event.pull_request.number).toBe(1);
  });

  it("GitHubPullRequestReviewEvent has correct shape", () => {
    const event: GitHubPullRequestReviewEvent = {
      action: "submitted",
      review: {
        id: 1,
        body: "Needs changes",
        state: "changes_requested",
        html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-1",
        user: { id: 1, login: "reviewer", avatar_url: "", html_url: "" },
      },
      pull_request: {
        number: 1,
        title: "Fix bug",
        head: {
          sha: "abc123",
          ref: "fix-branch",
          repo: {
            id: 1,
            name: "repo",
            full_name: "owner/repo",
            owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
            private: false,
            html_url: "https://github.com/owner/repo",
          },
        },
        base: {
          ref: "main",
          repo: {
            id: 1,
            name: "repo",
            full_name: "owner/repo",
            owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
            private: false,
            html_url: "https://github.com/owner/repo",
          },
        },
        user: { id: 2, login: "author", avatar_url: "", html_url: "" },
        html_url: "https://github.com/owner/repo/pull/1",
      },
      repository: {
        id: 1,
        name: "repo",
        full_name: "owner/repo",
        owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
        private: false,
        html_url: "https://github.com/owner/repo",
      },
      sender: { id: 1, login: "reviewer", avatar_url: "", html_url: "" },
    };
    expect(event.review.state).toBe("changes_requested");
  });
});
