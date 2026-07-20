import { describe, expect, it } from "vitest";
import {
  isCiFailureEvent,
  isReviewChangesRequested,
  isReviewCommentEvent,
  isActionableIssueCommentEvent,
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
        check_run: { id: 1, name: "CI", status: "completed", conclusion: "success", html_url: "", head_sha: "abc", head_branch: "feature" },
        repository: baseRepo,
        sender: baseSender,
      },
    };
    expect(toActionableEvent(event)).toBeNull();
  });
});

const sonarqubeSender = { id: 99, login: "sonarqubecloud[bot]", avatar_url: "", html_url: "" };
const coderabbitSender = { id: 100, login: "coderabbitai[bot]", avatar_url: "", html_url: "" };
const humanSender = { id: 101, login: "alice", avatar_url: "", html_url: "" };

const baseIssue = {
  number: 42,
  title: "Some PR",
  user: baseSender,
  html_url: "https://github.com/owner/test-repo/pull/42",
  pull_request: { url: "https://api.github.com/repos/owner/test-repo/issues/42", html_url: "https://github.com/owner/test-repo/pull/42" },
};

function makeIssueCommentEvent(
  action: "created" | "edited" | "deleted",
  body: string,
  sender = sonarqubeSender as typeof baseSender,
  issue: { number: number; title: string; user: typeof baseSender; html_url: string; pull_request?: { url: string; html_url: string } } = baseIssue,
): GitHubWebhookEvent {
  return {
    type: "issue_comment",
    payload: {
      action,
      comment: { id: 1, body, html_url: "https://github.com/owner/test-repo/issues/42#issuecomment-1", user: sender },
      issue,
      repository: baseRepo,
      sender,
    },
  };
}

const SONARQUBE_CLEAN = "## [![Quality Gate Passed](badge) **Quality Gate passed**\nIssues\n[0 New issues](url)\n[0 Accepted issues](url)\n\nMeasures\n[0 Security Hotspots](url)\n[83.2% Coverage on New Code](url)\n";
const SONARQUBE_WITH_ISSUES = "## [![Quality Gate Passed](badge) **Quality Gate passed**\nIssues\n[1 New issue](url)\n[0 Accepted issues](url)\n\nMeasures\n[0 Security Hotspots](url)\n[93.2% Coverage on New Code](url)\n";
const SONARQUBE_WITH_HOTSPOTS = "## [![Quality Gate Failed](badge) **Quality Gate failed**\nIssues\n[0 New issues](url)\n\nMeasures\n[2 Security Hotspots](url)\n";
const CODERABBIT_ACTIONABLE = "> [!NOTE]\n> **Actionable comments posted: 3**\n\nReview details below...\n";
const CODERABBIT_CLEAN = "> [!NOTE]\n> **Actionable comments posted: 0**\n\nReview details below...\n";
const CODERABBIT_RATE_LIMIT = "> [!WARNING]\n> ## Review limit reached\n\nYou've reached your PR review limit...\n";
const CODERABBIT_SUGGESTION = "Here is a suggestion:\n\n```suggestion\nfixed code\n```\n";

describe("isActionableIssueCommentEvent", () => {
  it("returns true for SonarQube comment with new issues on a PR", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", SONARQUBE_WITH_ISSUES))).toBe(true);
  });

  it("returns true for SonarQube comment with security hotspots on a PR", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", SONARQUBE_WITH_HOTSPOTS))).toBe(true);
  });

  it("returns false for SonarQube comment with no new issues or hotspots", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", SONARQUBE_CLEAN))).toBe(false);
  });

  it("returns true for CodeRabbit comment with actionable comments > 0", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", CODERABBIT_ACTIONABLE, coderabbitSender))).toBe(true);
  });

  it("returns true for CodeRabbit comment containing a suggestion block", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", CODERABBIT_SUGGESTION, coderabbitSender))).toBe(true);
  });

  it("returns false for CodeRabbit comment with 0 actionable comments and no suggestions", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", CODERABBIT_CLEAN, coderabbitSender))).toBe(false);
  });

  it("returns false for CodeRabbit rate-limit warning", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", CODERABBIT_RATE_LIMIT, coderabbitSender))).toBe(false);
  });

  it("returns false for issue_comment.edited (only created is actionable)", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("edited", SONARQUBE_WITH_ISSUES))).toBe(false);
  });

  it("returns false for issue_comment on a plain issue (not a PR)", () => {
    const e = makeIssueCommentEvent("created", SONARQUBE_WITH_ISSUES, sonarqubeSender, {
      number: 42, title: "Some issue", user: baseSender, html_url: "https://github.com/owner/test-repo/issues/42",
      // no pull_request field
    });
    expect(isActionableIssueCommentEvent(e)).toBe(false);
  });

  it("returns false for human issue comments (only automation bots are handled)", () => {
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", "Please fix this", humanSender))).toBe(false);
  });

  it("returns false for unknown bot login", () => {
    const unknownBot = { id: 999, login: "unknown-bot[bot]", avatar_url: "", html_url: "" };
    expect(isActionableIssueCommentEvent(makeIssueCommentEvent("created", SONARQUBE_WITH_ISSUES, unknownBot))).toBe(false);
  });
});

describe("toActionableEvent for issue_comment", () => {
  it("converts actionable SonarQube comment to review_summary", () => {
    const result = toActionableEvent(makeIssueCommentEvent("created", SONARQUBE_WITH_ISSUES));
    expect(result).not.toBeNull();
    expect(result!.type).toBe("review_summary");
    expect(result!.prNumber).toBe(42);
    expect(result!.sender).toBe("sonarqubecloud[bot]");
    expect(result!.message).toBe(SONARQUBE_WITH_ISSUES);
    // headSha/headRef are empty — resolved later by SessionManager.enrichReviewSummary.
    expect(result!.headSha).toBe("");
    expect(result!.headRef).toBe("");
  });

  it("returns null for non-actionable issue comments", () => {
    expect(toActionableEvent(makeIssueCommentEvent("created", SONARQUBE_CLEAN))).toBeNull();
    expect(toActionableEvent(makeIssueCommentEvent("created", CODERABBIT_CLEAN, coderabbitSender))).toBeNull();
  });
});
