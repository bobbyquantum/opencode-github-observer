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
  type: "ci_failure" | "review_comment" | "review_changes_requested";
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

  return null;
}
