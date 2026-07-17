import { describe, expect, it } from "vitest";
import {
  isCiFailureEvent,
  isReviewChangesRequested,
  isReviewCommentEvent,
  toActionableEvent,
  type GitHubWebhookEvent,
} from "../src/events.js";

const baseRepo = { id: 1, name: "test-repo", full_name: "owner/test-repo", owner: { id: 1, login: "owner", avatar_url: "", html_url: "" }, private: false, html_url: "" };
const baseSender = { id: 2, login: "sender", avatar_url: "", html_url: "" };

describe("isCiFailureEvent", () => {
  it("returns true for completed check_run with failure conclusion", () => {
    const event: GitHubWebhookEvent = {
      type: "check_run",
      payload: {
        action: "completed",
        check_run: { id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "", head_sha: "abc123", head_branch: "feature" },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(isCiFailureEvent(event)).toBe(true);
  });

  it("returns false for completed check_run with success conclusion", () => {
    const event: GitHubWebhookEvent = {
      type: "check_run",
      payload: {
        action: "completed",
        check_run: { id: 1, name: "CI", status: "completed", conclusion: "success", html_url: "", head_sha: "abc123", head_branch: "feature" },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(isCiFailureEvent(event)).toBe(false);
  });

  it("returns false for non-completed check_run", () => {
    const event: GitHubWebhookEvent = {
      type: "check_run",
      payload: {
        action: "created",
        check_run: { id: 1, name: "CI", status: "queued", conclusion: null, html_url: "", head_sha: "abc123", head_branch: "feature" },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(isCiFailureEvent(event)).toBe(false);
  });
});

describe("isReviewCommentEvent", () => {
  it("returns true for created review comment", () => {
    const event: GitHubWebhookEvent = {
      type: "pull_request_review_comment",
      payload: {
        action: "created",
        comment: { id: 1, body: "fix this", path: "file.ts", line: 10, html_url: "", user: baseSender },
        pull_request: {
          number: 1, title: "PR", head: { sha: "abc", ref: "feature", repo: baseRepo },
          base: { ref: "main", repo: baseRepo }, user: baseSender, html_url: "",
        },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(isReviewCommentEvent(event)).toBe(true);
  });

  it("returns false for edited review comment", () => {
    const event: GitHubWebhookEvent = {
      type: "pull_request_review_comment",
      payload: {
        action: "edited",
        comment: { id: 1, body: "fix this", path: "file.ts", line: 10, html_url: "", user: baseSender },
        pull_request: {
          number: 1, title: "PR", head: { sha: "abc", ref: "feature", repo: baseRepo },
          base: { ref: "main", repo: baseRepo }, user: baseSender, html_url: "",
        },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(isReviewCommentEvent(event)).toBe(false);
  });
});

describe("isReviewChangesRequested", () => {
  it("returns true for submitted review with changes_requested", () => {
    const event: GitHubWebhookEvent = {
      type: "pull_request_review",
      payload: {
        action: "submitted",
        review: { id: 1, body: "needs work", state: "changes_requested", html_url: "", user: baseSender },
        pull_request: {
          number: 1, title: "PR", head: { sha: "abc", ref: "feature", repo: baseRepo },
          base: { ref: "main", repo: baseRepo }, user: baseSender, html_url: "",
        },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(isReviewChangesRequested(event)).toBe(true);
  });

  it("returns false for approved review", () => {
    const event: GitHubWebhookEvent = {
      type: "pull_request_review",
      payload: {
        action: "submitted",
        review: { id: 1, body: "LGTM", state: "approved", html_url: "", user: baseSender },
        pull_request: {
          number: 1, title: "PR", head: { sha: "abc", ref: "feature", repo: baseRepo },
          base: { ref: "main", repo: baseRepo }, user: baseSender, html_url: "",
        },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(isReviewChangesRequested(event)).toBe(false);
  });
});

describe("toActionableEvent", () => {
  it("converts CI failure to actionable event", () => {
    const event: GitHubWebhookEvent = {
      type: "check_run",
      payload: {
        action: "completed",
        check_run: { id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "https://github.com/check/1", head_sha: "abc123", head_branch: "feature" },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    const result = toActionableEvent(event);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("ci_failure");
    expect(result!.headSha).toBe("abc123");
    expect(result!.headRef).toBe("feature");
    expect(result!.message).toContain("CI");
  });

  it("converts CI failure with null head_branch to empty headRef", () => {
    const event: GitHubWebhookEvent = {
      type: "check_run",
      payload: {
        action: "completed",
        check_run: { id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "", head_sha: "abc123", head_branch: null },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    const result = toActionableEvent(event);
    expect(result).not.toBeNull();
    expect(result!.headRef).toBe("");
  });

  it("converts review comment to actionable event", () => {
    const event: GitHubWebhookEvent = {
      type: "pull_request_review_comment",
      payload: {
        action: "created",
        comment: { id: 1, body: "fix this bug", path: "file.ts", line: 10, html_url: "https://github.com/comment/1", user: baseSender },
        pull_request: {
          number: 42, title: "My PR", head: { sha: "def456", ref: "feature", repo: baseRepo },
          base: { ref: "main", repo: baseRepo }, user: baseSender, html_url: "",
        },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    const result = toActionableEvent(event);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("review_comment");
    expect(result!.prNumber).toBe(42);
    expect(result!.headRef).toBe("feature");
    expect(result!.message).toBe("fix this bug");
  });

  it("converts changes_requested to actionable event", () => {
    const event: GitHubWebhookEvent = {
      type: "pull_request_review",
      payload: {
        action: "submitted",
        review: { id: 1, body: "please refactor", state: "changes_requested", html_url: "", user: baseSender },
        pull_request: {
          number: 7, title: "Refactor PR", head: { sha: "ghi789", ref: "refactor", repo: baseRepo },
          base: { ref: "main", repo: baseRepo }, user: baseSender, html_url: "",
        },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    const result = toActionableEvent(event);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("review_changes_requested");
    expect(result!.prNumber).toBe(7);
  });

  it("returns null for non-actionable events", () => {
    const event: GitHubWebhookEvent = {
      type: "check_run",
      payload: {
        action: "completed",
        check_run: { id: 1, name: "CI", status: "completed", conclusion: "success", html_url: "", head_sha: "abc" },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(toActionableEvent(event)).toBeNull();
  });
});
