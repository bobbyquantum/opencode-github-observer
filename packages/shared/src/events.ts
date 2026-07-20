export type GitHubCheckRunEvent = {
  action: "created" | "completed" | "rerequested" | "requested_action";
  check_run: {
    id: number;
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | null;
    html_url: string;
    head_sha: string;
    head_branch: string | null;
  };
  repository: GitHubRepository;
  sender: GitHubUser;
};

export type GitHubPullRequestReviewCommentEvent = {
  action: "created" | "edited" | "deleted";
  comment: {
    id: number;
    body: string;
    path: string;
    line: number | null;
    html_url: string;
    user: GitHubUser;
  };
  pull_request: {
    number: number;
    title: string;
    head: { sha: string; ref: string; repo: GitHubRepository };
    base: { ref: string; repo: GitHubRepository };
    user: GitHubUser;
    html_url: string;
  };
  repository: GitHubRepository;
  sender: GitHubUser;
};

export type GitHubPullRequestReviewEvent = {
  action: "submitted" | "edited" | "dismissed";
  review: {
    id: number;
    body: string | null;
    state: "approved" | "changes_requested" | "commented" | "pending" | "dismissed";
    html_url: string;
    user: GitHubUser;
  };
  pull_request: {
    number: number;
    title: string;
    head: { sha: string; ref: string; repo: GitHubRepository };
    base: { ref: string; repo: GitHubRepository };
    user: GitHubUser;
    html_url: string;
  };
  repository: GitHubRepository;
  sender: GitHubUser;
};

export type GitHubIssueCommentEvent = {
  action: "created" | "edited" | "deleted";
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: GitHubUser;
  };
  issue: {
    number: number;
    title: string;
    pull_request?: { url: string; html_url: string };
    user: GitHubUser;
    html_url: string;
  };
  repository: GitHubRepository;
  sender: GitHubUser;
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubUser;
  private: boolean;
  html_url: string;
};

export type GitHubUser = {
  id: number;
  login: string;
  avatar_url: string;
  html_url: string;
};

export type GitHubWebhookEvent =
  | { type: "check_run"; payload: GitHubCheckRunEvent }
  | { type: "pull_request_review_comment"; payload: GitHubPullRequestReviewCommentEvent }
  | { type: "pull_request_review"; payload: GitHubPullRequestReviewEvent }
  | { type: "issue_comment"; payload: GitHubIssueCommentEvent };

export type ActionableEvent = {
  type: "ci_failure" | "review_comment" | "review_changes_requested" | "review_summary";
  repo: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  message: string;
  htmlUrl: string;
  sender: string;
  timestamp: string;
};

export function isCiFailureEvent(event: GitHubWebhookEvent): event is GitHubWebhookEvent & { type: "check_run" } {
  return (
    event.type === "check_run" &&
    event.payload.action === "completed" &&
    event.payload.check_run.conclusion === "failure"
  );
}

export function isReviewCommentEvent(
  event: GitHubWebhookEvent,
): event is GitHubWebhookEvent & { type: "pull_request_review_comment" } {
  return event.type === "pull_request_review_comment" && event.payload.action === "created";
}

export function isReviewChangesRequested(
  event: GitHubWebhookEvent,
): event is GitHubWebhookEvent & { type: "pull_request_review" } {
  return (
    event.type === "pull_request_review" &&
    event.payload.action === "submitted" &&
    event.payload.review.state === "changes_requested"
  );
}

// Automation bots that post actionable review summaries as issue comments.
// We only act on these — human issue comments are intentionally NOT handled
// here (a human reviewer should be replied to, not auto-fixed blindly).
const ACTIONABLE_ISSUE_COMMENT_BOTS = new Set([
  "sonarqubecloud[bot]",
  "coderabbitai[bot]",
  "sonarcloud[bot]",
]);

// Returns true for issue comments authored by an automation bot we recognise
// AND that contain actionable content (not a clean pass / rate-limit notice).
// CodeRabbit summary comments with a "Actionable comments posted" count > 0
// are actionable. SonarQube "Quality Gate passed" comments are actionable
// only when they report new issues or security hotspots.
export function isActionableIssueCommentEvent(
  event: GitHubWebhookEvent,
): event is GitHubWebhookEvent & { type: "issue_comment" } {
  if (event.type !== "issue_comment") return false;
  if (event.payload.action !== "created") return false;
  // Only PRs, not plain issues — the autofixer works on PR branches.
  if (!event.payload.issue.pull_request) return false;
  if (!ACTIONABLE_ISSUE_COMMENT_BOTS.has(event.payload.sender.login)) return false;
  return hasActionableContent(event.payload.comment.body, event.payload.sender.login);
}

function hasActionableContent(body: string, sender: string): boolean {
  if (sender === "sonarqubecloud[bot]" || sender === "sonarcloud[bot]") {
    // SonarQube: actionable if there are new issues or security hotspots.
    // The comment body contains lines like "[0 New issues]" / "[1 New issue]".
    // Parse the count; act only when > 0.
    const newIssuesMatch = body.match(/\[(\d+)\s+New\s+issue/i);
    const newIssues = newIssuesMatch ? parseInt(newIssuesMatch[1], 10) : 0;
    const hotspotsMatch = body.match(/\[(\d+)\s+Security\s+Hotspots?\]/i);
    const hotspots = hotspotsMatch ? parseInt(hotspotsMatch[1], 10) : 0;
    return newIssues > 0 || hotspots > 0;
  }
  if (sender === "coderabbitai[bot]") {
    // CodeRabbit summary comment: actionable if it contains "Actionable
    // comments posted: N" with N > 0. Skip rate-limit warnings and clean
    // "no comments" summaries.
    const actionableMatch = body.match(/Actionable\s+comments\s+posted:\s*(\d+)/i);
    const actionable = actionableMatch ? parseInt(actionableMatch[1], 10) : 0;
    // Also treat comments containing inline suggestions (```suggestion blocks)
    // as actionable even if the "Actionable comments posted" line is absent.
    const hasSuggestion = /```suggestion/.test(body);
    return actionable > 0 || hasSuggestion;
  }
  return false;
}

export function toActionableEvent(event: GitHubWebhookEvent): ActionableEvent | null {
  if (isCiFailureEvent(event)) {
    const p = event.payload;
    return {
      type: "ci_failure",
      repo: p.repository.full_name,
      repoFullName: p.repository.full_name,
      prNumber: 0,
      prTitle: "",
      headSha: p.check_run.head_sha,
      headRef: p.check_run.head_branch ?? "",
      baseRef: "",
      message: `Check run "${p.check_run.name}" failed`,
      htmlUrl: p.check_run.html_url,
      sender: p.sender.login,
      timestamp: new Date().toISOString(),
    };
  }

  if (isReviewCommentEvent(event)) {
    const p = event.payload;
    return {
      type: "review_comment",
      repo: p.repository.full_name,
      repoFullName: p.repository.full_name,
      prNumber: p.pull_request.number,
      prTitle: p.pull_request.title,
      headSha: p.pull_request.head.sha,
      headRef: p.pull_request.head.ref,
      baseRef: p.pull_request.base.ref,
      message: p.comment.body,
      htmlUrl: p.comment.html_url,
      sender: p.sender.login,
      timestamp: new Date().toISOString(),
    };
  }

  if (isReviewChangesRequested(event)) {
    const p = event.payload;
    return {
      type: "review_changes_requested",
      repo: p.repository.full_name,
      repoFullName: p.repository.full_name,
      prNumber: p.pull_request.number,
      prTitle: p.pull_request.title,
      headSha: p.pull_request.head.sha,
      headRef: p.pull_request.head.ref,
      baseRef: p.pull_request.base.ref,
      message: p.review.body ?? "Changes requested",
      htmlUrl: p.review.html_url,
      sender: p.sender.login,
      timestamp: new Date().toISOString(),
    };
  }

  if (isActionableIssueCommentEvent(event)) {
    const p = event.payload;
    // The issue_comment webhook payload doesn't include head sha/branch, so
    // the session manager enriches these via the branch-pr cache + GitHub
    // API before prompting (same path as ci_failure enrichment).
    return {
      type: "review_summary",
      repo: p.repository.full_name,
      repoFullName: p.repository.full_name,
      prNumber: p.issue.number,
      prTitle: p.issue.title,
      headSha: "",
      headRef: "",
      baseRef: "",
      message: p.comment.body,
      htmlUrl: p.comment.html_url,
      sender: p.sender.login,
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}
