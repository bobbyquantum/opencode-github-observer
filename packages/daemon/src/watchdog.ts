import type { BranchPrCache } from "./branch-pr-cache.js";
import { logger } from "./logger.js";

export type WatchdogConfig = {
  // Re-prompt a session if it has been idle longer than this. Default 30 min.
  idleThresholdMs: number;
  // Only consider PRs whose branch-pr cache entry was updated within this
  // window. Avoids re-prompting for ancient PRs. Default 7 days.
  prMaxAgeMs: number;
  // Maximum number of open PRs to scan per run (GitHub API rate-limit guard).
  // Default 30.
  maxPrsPerRun: number;
};

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  idleThresholdMs: 30 * 60 * 1000, // 30 min
  prMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxPrsPerRun: 30,
};

// A PR currently failing CI that we may want to re-prompt a session for.
export type FailingPr = {
  prNumber: number;
  branch: string;
  headSha: string;
  failNames: string[];
};

// A PR with a merge conflict (mergeable_state === "conflicted"). The base
// branch has moved ahead and the PR's branch needs a rebase to land cleanly.
// Without intervention these PRs sit forever — the watchdog prompts the
// session to pull the base branch and resolve conflicts.
export type ConflictingPr = {
  prNumber: number;
  branch: string;
  headSha: string;
  baseRef: string;
};

export type WatchdogResult = {
  // PRs that are currently failing CI AND have a fresh entry in the
  // branch-pr cache (so we know which session to re-prompt).
  failingPrs: FailingPr[];
  // PRs that were failing but had no session mapping (daemon hasn't seen
  // them yet — needs an initial event to create the session).
  unmappedPrs: FailingPr[];
  // PRs with merge conflicts that have a fresh session mapping. The session
  // is prompted to rebase on the base branch and resolve conflicts.
  conflictingPrs: ConflictingPr[];
};

export type GithubApiDeps = {
  fetch?: typeof fetch;
};

type Pull = {
  number: number;
  head: { ref: string; sha: string };
  // mergeable_state is computed asynchronously by GitHub; can be null when
  // GitHub hasn't finished computing it yet (fresh PR).
  mergeable_state?: string | null;
  base?: { ref: string };
};

type CheckRun = {
  name: string;
  conclusion: string | null;
  head_sha: string;
};

// Fetches all open PRs for a repo. Paginates up to maxPrs.
export async function fetchOpenPrs(
  repo: string,
  token: string,
  maxPrs: number,
  deps: GithubApiDeps = {},
): Promise<Pull[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=${Math.min(maxPrs, 100)}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-observer-watchdog",
    },
  });
  if (!res.ok) throw new Error(`fetchOpenPrs ${repo} returned ${res.status}`);
  const prs = (await res.json()) as Pull[];
  return prs.slice(0, maxPrs);
}

// Fetches failing check-run names for a given commit sha. Returns the
// deduplicated list of check names with conclusion=FAILURE on the given sha.
export async function fetchFailingChecks(
  repo: string,
  sha: string,
  token: string,
  deps: GithubApiDeps = {},
): Promise<string[]> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-observer-watchdog",
    },
  });
  if (!res.ok) throw new Error(`fetchFailingChecks ${repo}@${sha.slice(0, 7)} returned ${res.status}`);
  const body = (await res.json()) as { check_runs?: CheckRun[] };
  const runs = body.check_runs ?? [];
  const failNames = runs
    .filter((r) => r.conclusion === "failure" && r.head_sha === sha)
    .map((r) => r.name);
  return Array.from(new Set(failNames));
}

// Fetches a single PR's full data, including mergeable_state. GitHub
// computes mergeable_state asynchronously, so the list endpoint returns null
// for all PRs. Fetching a PR individually triggers computation; if the first
// call returns "unknown", a second call shortly after returns the real state.
export async function fetchPrDetail(
  repo: string,
  prNumber: number,
  token: string,
  deps: GithubApiDeps = {},
): Promise<Pull & { mergeable_state?: string | null }> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-observer-watchdog",
    },
  });
  if (!res.ok) throw new Error(`fetchPrDetail ${repo}#${prNumber} returned ${res.status}`);
  return (await res.json()) as Pull;
}

// Determines if a PR's branch-pr cache entry is fresh enough to consider.
export function isPrEntryFresh(updatedAt: string, now: number, maxAgeMs: number): boolean {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return false;
  return now - ts < maxAgeMs;
}

// Returns true if the PR's mergeable_state indicates the branch is unmergable
// and needs intervention (rebase or conflict resolution). GitHub's states:
//   - "conflicted" — base branch moved ahead, rebase needed
//   - "dirty" — PR's own commits conflict with base; needs rebase or
//     conflict resolution (a simple rebase may not be enough)
//   - "behind" — base moved ahead but no conflicts (rebase nice-to-have,
//     not required — NOT actionable)
//   - "blocked" — failing required checks (handled by CI-failure detection)
//   - "unstable" — failing checks but mergeable (handled by CI-failure)
//   - "clean" — mergeable, no action needed
// We act on "conflicted" and "dirty" — both mean the branch can't merge.
export function isPrUnmergable(mergeableState: string | null | undefined): boolean {
  return mergeableState === "conflicted" || mergeableState === "dirty";
}

// Back-compat alias for the old name; isPrConflicted now returns true for
// both conflicted and dirty. Prefer isPrUnmergable in new code.
export const isPrConflicted = isPrUnmergable;

// Scans open PRs on a repo for current CI failures AND merge conflicts.
// Returns:
//   - failingPrs: PRs failing CI that have a fresh session mapping in the
//     branch-pr cache (so the daemon knows which session to re-prompt)
//   - unmappedPrs: PRs failing CI that have no session mapping yet (the
//     daemon needs an initial event to create a session)
//   - conflictingPrs: PRs with merge conflicts that have a fresh session
//     mapping. The session is prompted to pull the base branch and resolve
//     conflicts.
// The caller (daemon) is responsible for deciding whether to actually re-prompt
// based on each session's last-activity timestamp (via SessionManager).
//
// NOTE on mergeable_state: GitHub computes this asynchronously. The list
// endpoint (/pulls?state=open) returns mergeable_state=null for all PRs.
// To get the real state, we fetch each cached PR individually — this triggers
// computation. If the first call returns "unknown", we retry once after a
// short delay.
export async function findFailingPrs(
  repo: string,
  token: string,
  cache: BranchPrCache,
  config: WatchdogConfig,
  deps: GithubApiDeps = {},
): Promise<WatchdogResult> {
  const now = Date.now();
  const failingPrs: FailingPr[] = [];
  const unmappedPrs: FailingPr[] = [];
  const conflictingPrs: ConflictingPr[] = [];

  let prs: Pull[];
  try {
    prs = await fetchOpenPrs(repo, token, config.maxPrsPerRun, deps);
  } catch (err) {
    logger.warn(`watchdog: failed to fetch open PRs for ${repo}`, err);
    return { failingPrs, unmappedPrs, conflictingPrs };
  }

  // For each PR that has a fresh cache entry, fetch full detail to get the
  // real mergeable_state. The list endpoint returns null for all PRs because
  // GitHub computes mergeability asynchronously. Only fetch detail for PRs
  // we're tracking (have a cache entry) to avoid hitting the API for every
  // open PR.
  const cachedPrNumbers = new Set<number>();
  for (const pr of prs) {
    const entry = cache.lookupByPr(repo, pr.number);
    if (entry && entry.headSha && isPrEntryFresh(entry.updatedAt, now, config.prMaxAgeMs)) {
      cachedPrNumbers.add(pr.number);
    }
  }

  // Fetch detail for cached PRs in parallel (with one retry if the first
  // call returns "unknown").
  const detailByNumber = new Map<number, Pull>();
  await Promise.all(
    Array.from(cachedPrNumbers).map(async (prNumber) => {
      try {
        let detail = await fetchPrDetail(repo, prNumber, token, deps);
        if (detail.mergeable_state === "unknown") {
          // GitHub hasn't finished computing — retry once after a short delay.
          await new Promise((r) => setTimeout(r, 500));
          detail = await fetchPrDetail(repo, prNumber, token, deps);
        }
        detailByNumber.set(prNumber, detail);
      } catch (err) {
        logger.debug(`watchdog: failed to fetch PR detail for ${repo}#${prNumber}`, err);
      }
    }),
  );

  for (const pr of prs) {
    // Check for merge conflicts using the detailed PR data (if we fetched it).
    const detail = detailByNumber.get(pr.number) ?? pr;
    if (isPrConflicted(detail.mergeable_state)) {
      const entry = cache.lookupByPr(repo, pr.number);
      if (entry && entry.headSha && isPrEntryFresh(entry.updatedAt, now, config.prMaxAgeMs)) {
        conflictingPrs.push({
          prNumber: pr.number,
          branch: pr.head.ref,
          headSha: pr.head.sha,
          baseRef: detail.base?.ref ?? "main",
        });
      }
    }

    let failNames: string[];
    try {
      failNames = await fetchFailingChecks(repo, pr.head.sha, token, deps);
    } catch (err) {
      logger.debug(`watchdog: failed to fetch check-runs for ${repo}#${pr.number}`, err);
      continue;
    }
    if (failNames.length === 0) continue;

    const entry = cache.lookupByPr(repo, pr.number);
    const candidate = {
      prNumber: pr.number,
      branch: pr.head.ref,
      headSha: pr.head.sha,
      failNames,
    };

    if (!entry || !entry.headSha) {
      unmappedPrs.push(candidate);
      continue;
    }
    if (!isPrEntryFresh(entry.updatedAt, now, config.prMaxAgeMs)) {
      // Stale mapping — skip (PR probably forgotten).
      continue;
    }
    failingPrs.push(candidate);
  }

  return { failingPrs, unmappedPrs, conflictingPrs };
}