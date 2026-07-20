import type { BranchPrCache } from "./branch-pr-cache.js";
import { logger } from "./logger.js";

export type PrLookupResult = {
  prNumber: number;
  branch: string;
  headSha: string;
};

export type GitHubPrInfo = {
  number: number;
  head: { ref: string; sha: string };
};

export type GitHubLookupDeps = {
  // Fetch wrapper so tests can mock without touching globalThis.fetch.
  fetch?: typeof fetch;
  // Optional in-memory memo keyed by `${repo}:${sha}` -> result + expiry.
  memoTtlMs?: number;
};

type MemoEntry = { result: PrLookupResult | null; expires: number };

const DEFAULT_MEMO_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Resolves a PR for a given repo + commit sha. Uses the branch-pr cache first
// (free, local), then falls back to the GitHub API and records the result back
// into the cache so subsequent lookups are instant.
export async function resolvePrForSha(
  repo: string,
  headSha: string,
  branchHint: string,
  token: string,
  cache: BranchPrCache,
  deps: GitHubLookupDeps = {},
): Promise<PrLookupResult | null> {
  // 1. Cache hit by sha.
  const bySha = cache.lookupBySha(repo, headSha);
  if (bySha) {
    return { prNumber: bySha.prNumber, branch: bySha.branch, headSha };
  }

  // 2. Cache hit by branch hint (sha may have been missed on the first push).
  if (branchHint) {
    const byBranch = cache.lookupByBranch(repo, branchHint);
    if (byBranch) {
      // Refresh headSha if missing so future sha lookups hit.
      if (!byBranch.headSha) cache.record(repo, branchHint, byBranch.prNumber, headSha);
      return { prNumber: byBranch.prNumber, branch: branchHint, headSha };
    }
  }

  // 3. GitHub API fallback.
  const result = await fetchPrForSha(repo, headSha, token, deps);
  if (!result) {
    logger.debug(`No PR found for ${repo}@${headSha.slice(0, 7)} via GitHub API`);
    return null;
  }

  // Record into the cache so future events on this sha/branch are instant.
  cache.record(repo, result.head.ref, result.number, result.head.sha);
  await cache.persist();
  return { prNumber: result.number, branch: result.head.ref, headSha: result.head.sha };
}

// Resolves a PR's head sha + branch from a PR number. Uses the branch-pr cache
// first (free), then the GitHub API and records the result back into the
// cache. Used to enrich review_summary events (issue_comment webhook payloads
// don't include the head sha/branch).
export async function resolvePrByNumber(
  repo: string,
  prNumber: number,
  token: string,
  cache: BranchPrCache,
  deps: GitHubLookupDeps = {},
): Promise<PrLookupResult | null> {
  if (!prNumber) return null;

  // 1. Cache hit by PR number.
  const byPr = cache.lookupByPr(repo, prNumber);
  if (byPr && byPr.headSha) {
    return { prNumber, branch: byPr.branch, headSha: byPr.headSha };
  }

  // 2. GitHub API fallback.
  const result = await fetchPrByNumber(repo, prNumber, token, deps);
  if (!result) {
    logger.debug(`No PR found for ${repo}#${prNumber} via GitHub API`);
    return null;
  }

  cache.record(repo, result.head.ref, result.number, result.head.sha);
  await cache.persist();
  return { prNumber: result.number, branch: result.head.ref, headSha: result.head.sha };
}

// In-process memo so we don't re-query GitHub for the same PR within a session.
const prMemo = new Map<string, GitHubPrInfo | null>();

export async function fetchPrByNumber(
  repo: string,
  prNumber: number,
  token: string,
  deps: GitHubLookupDeps = {},
): Promise<GitHubPrInfo | null> {
  const memoKey = `${repo}:${prNumber}`;
  const memoed = prMemo.get(memoKey);
  if (memoed !== undefined) return memoed;

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  let result: GitHubPrInfo | null = null;
  try {
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-observer-daemon",
      },
    });
    if (res.ok) {
      const pr = (await res.json()) as {
        number: number;
        head: { ref: string; sha: string };
      };
      result = { number: pr.number, head: pr.head };
    } else if (res.status !== 404) {
      logger.warn(`GitHub PR lookup for ${repo}#${prNumber} returned ${res.status}`);
    }
  } catch (err) {
    logger.warn(`GitHub PR lookup failed for ${repo}#${prNumber}`, err);
  }

  prMemo.set(memoKey, result);
  return result;
}

// In-process memo so we don't re-query GitHub for the same sha within a session.
const shaMemo = new Map<string, MemoEntry>();
// Re-add the fetchPrForSha function that uses shaMemo (defined above).
export async function fetchPrForSha(
  repo: string,
  headSha: string,
  token: string,
  deps: GitHubLookupDeps = {},
): Promise<GitHubPrInfo | null> {
  const ttl = deps.memoTtlMs ?? DEFAULT_MEMO_TTL_MS;
  const memoKey = `${repo}:${headSha}`;
  const now = Date.now();

  const memoed = shaMemo.get(memoKey);
  if (memoed && memoed.expires > now) return memoed.result ? toPrInfo(memoed.result) : null;

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const url = `https://api.github.com/repos/${repo}/commits/${headSha}/pulls?per_page=1`;
  let result: GitHubPrInfo | null = null;
  try {
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-observer-daemon",
      },
    });
    if (res.ok) {
      const prs = (await res.json()) as Array<{
        number: number;
        head: { ref: string; sha: string };
      }>;
      if (prs.length > 0) {
        result = { number: prs[0].number, head: prs[0].head };
      }
    } else if (res.status !== 404) {
      logger.warn(`GitHub PR lookup for ${repo}@${headSha.slice(0, 7)} returned ${res.status}`);
    }
  } catch (err) {
    logger.warn(`GitHub PR lookup failed for ${repo}@${headSha.slice(0, 7)}`, err);
  }

  shaMemo.set(memoKey, { result: result ? fromPrInfo(result) : null, expires: now + ttl });
  return result;
}

function toPrInfo(r: PrLookupResult): GitHubPrInfo {
  return { number: r.prNumber, head: { ref: r.branch, sha: r.headSha } };
}

function fromPrInfo(i: GitHubPrInfo): PrLookupResult {
  return { prNumber: i.number, branch: i.head.ref, headSha: i.head.sha };
}

// Test helper to reset the in-process memos between tests.
export function _resetShaMemo(): void {
  shaMemo.clear();
  prMemo.clear();
}