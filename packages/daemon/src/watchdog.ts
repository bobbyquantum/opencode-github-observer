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

export type WatchdogResult = {
  // PRs that are currently failing CI AND have a fresh entry in the
  // branch-pr cache (so we know which session to re-prompt).
  failingPrs: FailingPr[];
  // PRs that were failing but had no session mapping (daemon hasn't seen
  // them yet — needs an initial event to create the session).
  unmappedPrs: FailingPr[];
};

export type GithubApiDeps = {
  fetch?: typeof fetch;
};

type Pull = {
  number: number;
  head: { ref: string; sha: string };
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

// Determines if a PR's branch-pr cache entry is fresh enough to consider.
export function isPrEntryFresh(updatedAt: string, now: number, maxAgeMs: number): boolean {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return false;
  return now - ts < maxAgeMs;
}

// Scans open PRs on a repo for current CI failures. Returns:
//   - failingPrs: PRs failing CI that have a fresh session mapping in the
//     branch-pr cache (so the daemon knows which session to re-prompt)
//   - unmappedPrs: PRs failing CI that have no session mapping yet (the
//     daemon needs an initial event to create a session)
// The caller (daemon) is responsible for deciding whether to actually re-prompt
// based on each session's last-activity timestamp (via SessionManager).
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

  let prs: Pull[];
  try {
    prs = await fetchOpenPrs(repo, token, config.maxPrsPerRun, deps);
  } catch (err) {
    logger.warn(`watchdog: failed to fetch open PRs for ${repo}`, err);
    return { failingPrs, unmappedPrs };
  }

  for (const pr of prs) {
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

  return { failingPrs, unmappedPrs };
}