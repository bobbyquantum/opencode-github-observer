import type { ActionableEvent, RepoConfig } from "@opencode-observer/shared";
import { logger } from "./logger.js";
import { SessionMap } from "./session-map.js";
import { OpencodeServerManager } from "./server-manager.js";
import type { OpencodeClient } from "./opencode/client.js";
import type { Session } from "./opencode/types.js";
import type { BranchPrCache } from "./branch-pr-cache.js";
import { resolvePrForSha, resolvePrByNumber } from "./github-lookup.js";

export type SessionStatus = "idle" | "investigating" | "fixing" | "done" | "error";

export type SessionInfo = {
  sessionID: string;
  repo: string;
  prNumber: number;
  headRef: string;
  status: SessionStatus;
  lastEvent: ActionableEvent | null;
  startedAt: string;
};

export type SessionManagerDeps = {
  repos: Record<string, RepoConfig>;
  serverManager: OpencodeServerManager;
  sessionMap: SessionMap;
  branchPrCache?: BranchPrCache;
  githubToken?: string;
  cooldownMs?: number;
};

const SEARCH_SESSION_LIMIT = 20;

// Dedup window: don't re-prompt the same session for the same event signature
// within this period. Default 5 minutes — long enough to absorb a batch of
// coderabbit comments or a multi-shard CI failure, short enough to react to a
// genuinely new failure on the same branch.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

type CooldownKey = string;
type CooldownEntry = { expires: number };

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cooldowns = new Map<CooldownKey, CooldownEntry>();
  private readonly cooldownMs: number;

  constructor(private deps: SessionManagerDeps) {
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  getAll(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  get(sessionID: string): SessionInfo | undefined {
    return this.sessions.get(sessionID);
  }

  async handleEvent(event: ActionableEvent): Promise<void> {
    const repoConfig = this.deps.repos[event.repo];
    if (!repoConfig) {
      logger.warn(`No workdir configured for ${event.repo}; skipping event`, {
        type: event.type,
      });
      return;
    }

    // Enrich CI-failure events with PR number + canonical branch when missing.
    // GitHub's check_run webhook payload has no PR number, so we resolve it via
    // the branch-pr cache (instant) or the GitHub API (memoised).
    let enriched = event;
    if (event.type === "ci_failure" && event.prNumber === 0 && this.deps.branchPrCache && this.deps.githubToken) {
      enriched = await this.enrichCiFailure(event);
    }
    // Enrich review_summary events (from issue_comment webhook) with head sha +
    // branch. The issue_comment payload has only the PR number, not the sha.
    if (event.type === "review_summary" && !event.headSha && this.deps.branchPrCache && this.deps.githubToken) {
      enriched = await this.enrichReviewSummary(event);
    }

    // Dedup: skip if we already prompted this session for an equivalent event
    // within the cooldown window. Equivalent = same session key (repo+branch
    // or repo+PR) and same event type. Prevents a batch of coderabbit comments
    // or a multi-shard CI failure from re-prompting 10x in 1 second.
    const cooldownKey = this.cooldownKeyFor(enriched);
    if (cooldownKey && this.isInCooldown(cooldownKey)) {
      logger.info(`Skipping ${enriched.type} for ${enriched.repo}#${enriched.prNumber || enriched.headRef} (cooldown)`);
      return;
    }

    let client: OpencodeClient;
    try {
      const server = await this.deps.serverManager.ensure(repoConfig.workdir, repoConfig.serverUrl, repoConfig.serverPassword);
      client = server.client;
    } catch (err) {
      logger.error(`Could not reach opencode server for ${event.repo}`, err);
      return;
    }

    let sessionID: string;
    try {
      sessionID = await this.resolveSessionID(client, enriched);
    } catch (err) {
      logger.error(`Could not resolve session for ${event.repo}`, err);
      return;
    }

    const info =
      this.sessions.get(sessionID) ??
      ({
        sessionID,
        repo: enriched.repo,
        prNumber: enriched.prNumber,
        headRef: enriched.headRef,
        status: "idle" as SessionStatus,
        lastEvent: null,
        startedAt: new Date().toISOString(),
      } satisfies SessionInfo);
    info.lastEvent = enriched;
    info.status = "investigating";
    this.sessions.set(sessionID, info);

    // Record cooldown so near-duplicate events within the window are skipped.
    if (cooldownKey) this.setCooldown(cooldownKey);

    const prompt = buildPrompt(enriched);
    try {
      info.status = "fixing";
      await client.promptAsync(sessionID, { parts: [{ type: "text", text: prompt }] });
      logger.info(`Prompted session ${sessionID} for ${enriched.repo}#${enriched.prNumber || enriched.headRef}`, {
        type: enriched.type,
      });
    } catch (err) {
      info.status = "error";
      logger.error(`Failed to prompt session ${sessionID}`, err);
    }
  }

  // Resolves PR number + canonical branch for a CI failure event using the
  // branch-pr cache (free) then the GitHub API (memoised). Returns the event
  // with prNumber/prTitle/headRef populated when found, or the original event
  // unchanged when not.
  private async enrichCiFailure(event: ActionableEvent): Promise<ActionableEvent> {
    const cache = this.deps.branchPrCache!;
    const token = this.deps.githubToken!;
    if (!event.headSha && !event.headRef) return event;

    try {
      const result = await resolvePrForSha(
        event.repo,
        event.headSha,
        event.headRef,
        token,
        cache,
      );
      if (!result) return event;
      return {
        ...event,
        prNumber: result.prNumber,
        headRef: result.branch || event.headRef,
        headSha: result.headSha || event.headSha,
      };
    } catch (err) {
      logger.warn(`Failed to enrich CI failure for ${event.repo}`, err);
      return event;
    }
  }

  // Resolves head sha + canonical branch for a review_summary event (issue
  // comment webhook). The payload only has the PR number, so we look up by
  // PR number via the cache (free) then the GitHub API (memoised).
  private async enrichReviewSummary(event: ActionableEvent): Promise<ActionableEvent> {
    const cache = this.deps.branchPrCache!;
    const token = this.deps.githubToken!;
    if (!event.prNumber) return event;

    try {
      const result = await resolvePrByNumber(event.repo, event.prNumber, token, cache);
      if (!result) return event;
      return {
        ...event,
        headRef: result.branch || event.headRef,
        headSha: result.headSha || event.headSha,
      };
    } catch (err) {
      logger.warn(`Failed to enrich review summary for ${event.repo}`, err);
      return event;
    }
  }

  private cooldownKeyFor(event: ActionableEvent): string | null {
    const id = event.prNumber || event.headRef;
    if (!id) return null;
    return `${event.repo}:${event.type}:${id}`;
  }

  private isInCooldown(key: string): boolean {
    const entry = this.cooldowns.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expires) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }

  private setCooldown(key: string): void {
    this.cooldowns.set(key, { expires: Date.now() + this.cooldownMs });
  }

  // 1. Map lookup by branch / headSha / prNumber.
  // 2. Fallback: search existing sessions for a mention of the branch or PR.
  // 3. Otherwise: create a new session.
  async resolveSessionID(client: OpencodeClient, event: ActionableEvent): Promise<string> {
    const repo = event.repo;
    const existing = this.deps.sessionMap.lookup(repo, {
      ...(event.headRef ? { branch: event.headRef } : {}),
      ...(event.headSha ? { headSha: event.headSha } : {}),
      ...(event.prNumber ? { prNumber: event.prNumber } : {}),
    });

    if (existing) {
      try {
        const session = await client.getSession(existing.sessionID);
        // Refresh mapping with PR number / headSha if we now know them.
        this.recordResolved(session, repo, event);
        return session.id;
      } catch {
        logger.warn(`Mapped session ${existing.sessionID} no longer exists; searching`);
        this.deps.sessionMap.delete(existing.sessionID);
        await this.deps.sessionMap.persist();
      }
    }

    const found = await this.searchSessions(client, event);
    if (found) {
      this.recordResolved(found, repo, event);
      return found.id;
    }

    logger.info(`No existing session for ${repo}; starting a new one`);
    const created = await client.createSession(buildSessionTitle(event));
    this.recordResolved(created, repo, event);
    return created.id;
  }

  // Heuristic fallback when the session map has no hit. Tries to find the
  // originating opencode session by:
  //   1. Matching the PR branch name against the session's worktree directory
  //      via a /vcs query (the opencode server reports the branch checked out
  //      in each worktree, so a session whose worktree is on the event's branch
  //      is the originating session).
  //   2. Matching the PR branch name's last segment against the session's
  //      directory path (OpenChamber names worktrees after branches, e.g.
  //      branch "feat/x" → worktree ".../feat-x" — close but not exact).
  //   3. Matching the repo name or PR number against session titles.
  //   4. Scanning message text for branch / PR / URL mentions.
  // Prefers primary sessions (no parentID) over subagent sessions, and the
  // most recently updated session wins.
  //
  // GUARD: a session already mapped to a different branch in the session map
  // is NOT considered a match for the event's branch, even if its worktree's
  // /vcs reports the event's branch. OpenChamber reuses worktrees across
  // branches over time, so a /vcs match alone is unreliable — the session's
  // content belongs to its original branch, not whatever the worktree is on
  // now.
  async searchSessions(client: OpencodeClient, event: ActionableEvent): Promise<Session | null> {
    const sessions = await client.listSessions();
    const repoName = event.repo.split("/")[1] ?? "";

    // Build a set of sessionIDs already mapped to a DIFFERENT branch — those
    // sessions should not match this event even if /vcs says their worktree
    // is on event.headRef. OpenChamber reuses worktrees across branches.
    const sessionsOnOtherBranch = new Set<string>();
    for (const rec of this.deps.sessionMap.list()) {
      if (rec.repo !== event.repo) continue;
      if (rec.branch && rec.branch !== event.headRef) {
        sessionsOnOtherBranch.add(rec.sessionID);
      }
    }

    // Derive a worktree directory hint from the branch name. OpenCode worktree
    // dirs are named after the branch's last path segment, e.g. branch
    // "opencode/hidden-comet" → worktree dir ".../hidden-comet".
    const branchHint = event.headRef ? event.headRef.split("/").pop() ?? "" : "";

    // For each primary session, query the opencode server for the worktree's
    // current branch. Sessions whose worktree is on the event's branch are
    // exact matches. Cache the results per-client to avoid re-querying.
    const branchByDir = new Map<string, string | null>();
    const getBranchForDir = async (dir: string): Promise<string | null> => {
      if (branchByDir.has(dir)) return branchByDir.get(dir) ?? null;
      let branch: string | null = null;
      try {
        const vcs = await client.vcsInfoForDirectory(dir);
        branch = vcs.branch ?? null;
      } catch {
        // VCS query failed (or no git in that dir) — leave null.
      }
      branchByDir.set(dir, branch);
      return branch;
    };

    const score = async (s: Session): Promise<number> => {
      // GUARD: skip sessions already mapped to a different branch. They belong
      // to that branch's work, not this one — even if the worktree has since
      // been reassigned to our branch.
      if (sessionsOnOtherBranch.has(s.id)) return 0;

      let score = 0;
      // Primary sessions are strongly preferred over subagents.
      if (!s.parentID) score += 1000;
      // Exact branch match via /vcs query — strongest signal.
      if (s.directory && event.headRef) {
        const branch = await getBranchForDir(s.directory);
        if (branch && branch === event.headRef) score += 2000;
      }
      // Directory match by branch hint is a weaker fallback.
      if (branchHint && s.directory.includes(branchHint)) score += 500;
      // Repo name in directory or title.
      if (s.directory.includes(repoName)) score += 100;
      if (s.title.includes(repoName) || s.title.includes(event.repo)) score += 100;
      // PR number in title.
      if (event.prNumber && (s.title.includes(`#${event.prNumber}`) || s.title.includes(String(event.prNumber)))) score += 200;
      // Recency bonus (log scale, max ~50 for very recent).
      const ageSec = (Date.now() - s.time.updated) / 1000;
      score += Math.max(0, 50 - Math.log10(Math.max(1, ageSec)) * 10);
      return score;
    };

    // Score all sessions (concurrently to avoid serial /vcs round-trips).
    const scored = await Promise.all(sessions.map(async (s) => ({ s, score: await score(s) })));
    const candidates = scored
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_SESSION_LIMIT);

    if (candidates.length === 0 || candidates[0].score < 100) {
      // No strong directory/title match — fall back to message content search.
      // Also exclude sessions on other branches from the message search.
      const searchable = sessions.filter((s) => !sessionsOnOtherBranch.has(s.id));
      return this.searchByMessages(client, searchable, event, repoName);
    }

    // VALIDATION: even with a strong /vcs branch match, verify the session's
    // first user message references the event's branch/PR. A worktree can be
    // reassigned to a different branch while its session is about a totally
    // unrelated topic — a bare /vcs match is unsafe. If the top candidate
    // fails this check, fall through to message search.
    const top = candidates[0];
    if (top.score >= 2000 && top.s.directory && event.headRef) {
      const relevant = await this.sessionRelevantToEvent(client, top.s.id, event);
      if (!relevant) {
        // Demote the top candidate and try the next, or fall through to
        // message search.
        const remaining = candidates.slice(1);
        if (remaining.length > 0 && remaining[0].score >= 100) return remaining[0].s;
        const searchable = sessions.filter((s) => !sessionsOnOtherBranch.has(s.id) && s.id !== top.s.id);
        return this.searchByMessages(client, searchable, event, repoName);
      }
    }

    return candidates[0].s;
  }

  // Returns true if the session's first user message mentions the event's
  // branch, PR number, or htmlUrl — i.e. the session was originally about this
  // event's subject. Used to reject /vcs branch matches on reassigned
  // worktrees where the session's true topic is unrelated to the current
  // branch.
  private async sessionRelevantToEvent(
    client: OpencodeClient,
    sessionID: string,
    event: ActionableEvent,
  ): Promise<boolean> {
    const needles: string[] = [];
    if (event.headRef) needles.push(event.headRef);
    if (event.prNumber) needles.push(`#${event.prNumber}`, `pull/${event.prNumber}`);
    if (event.htmlUrl) needles.push(event.htmlUrl);
    if (needles.length === 0) return true; // can't validate — don't reject
    try {
      const messages = await client.messages(sessionID);
      const firstUserMsg = messages.find((m) => m.info.role === "user");
      if (!firstUserMsg) return true; // no user message — can't validate, don't reject
      return firstUserMsg.parts.some(
        (p) => p.type === "text" && needles.some((n) => (p as { text?: string }).text?.includes(n)),
      );
    } catch {
      return true; // can't read messages — don't reject
    }
  }

  private async searchByMessages(
    client: OpencodeClient,
    sessions: Session[],
    event: ActionableEvent,
    repoName: string,
  ): Promise<Session | null> {
    const needles: string[] = [];
    if (event.headRef) needles.push(event.headRef);
    if (event.prNumber) needles.push(`#${event.prNumber}`, `pull/${event.prNumber}`);
    if (event.htmlUrl) needles.push(event.htmlUrl);
    if (needles.length === 0) return null;

    // Only search primary sessions (no parentID), most recent first.
    const candidates = sessions
      .filter((s) => !s.parentID)
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, SEARCH_SESSION_LIMIT);

    // Fetch messages for all candidates in parallel. For 12+ sessions with
    // hundreds of messages each, this is a huge win over the sequential
    // loop (20 sequential round-trips → 1 parallel batch).
    const results = await Promise.all(
      candidates.map(async (session) => {
        try {
          const messages = await client.messages(session.id);
          // Only search the FIRST user message — the session's original topic.
          // Searching all messages catches polluted sessions that were
          // previously (wrongly) prompted about a different branch — their
          // later messages contain the wrong branch's needles, but their
          // first user message reflects the session's true topic.
          const firstUserMsg = messages.find((m) => m.info.role === "user");
          if (!firstUserMsg) return { session, hit: false };
          const hit = firstUserMsg.parts.some(
            (p) => p.type === "text" && needles.some((n) => (p as { text?: string }).text?.includes(n)),
          );
          return { session, hit };
        } catch {
          return { session, hit: false };
        }
      }),
    );

    // Return the first candidate (most recently updated) that has a needle
    // in its first user message.
    for (const { session, hit } of results) {
      if (hit) return session;
    }
    return null;
  }

  private recordResolved(session: Session, repo: string, event: ActionableEvent): void {
    this.deps.sessionMap.record({
      sessionID: session.id,
      repo,
      ...(event.headRef ? { branch: event.headRef } : {}),
      ...(event.headSha ? { headSha: event.headSha } : {}),
      ...(event.prNumber ? { prNumber: event.prNumber } : {}),
      updatedAt: new Date().toISOString(),
    });
    void this.deps.sessionMap.persist();
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
    this.cooldowns.clear();
  }

  // Called by the watchdog. Given a failing PR (PR number + branch + sha +
  // failing check names), finds the mapped session and re-prompts it IF:
  //   - the session exists in the session map
  //   - the session hasn't been updated in the opencode server for > idleThresholdMs
  //   - we haven't already prompted for this exact failure signature within cooldownMs
  // Returns "prompted" | "skipped:idle" | "skipped:no-session" | "skipped:cooldown"
  async repromptIfIdle(
    repo: string,
    prNumber: number,
    branch: string,
    headSha: string,
    failNames: string[],
    idleThresholdMs: number,
  ): Promise<string> {
    const repoConfig = this.deps.repos[repo];
    if (!repoConfig) return "skipped:no-session";

    // Look up the session in the session map by PR number.
    const mapped = this.deps.sessionMap.lookup(repo, { prNumber });
    if (!mapped) return "skipped:no-session";

    // Get the session from the opencode server to check its last-activity time.
    let client: OpencodeClient;
    try {
      const server = await this.deps.serverManager.ensure(repoConfig.workdir, repoConfig.serverUrl, repoConfig.serverPassword);
      client = server.client;
    } catch (err) {
      logger.error(`watchdog: could not reach opencode server for ${repo}`, err);
      return "skipped:no-session";
    }

    let session: Session;
    try {
      session = await client.getSession(mapped.sessionID);
    } catch (err) {
      logger.warn(`watchdog: mapped session ${mapped.sessionID} no longer exists for ${repo}#${prNumber}`);
      this.deps.sessionMap.delete(mapped.sessionID);
      await this.deps.sessionMap.persist();
      return "skipped:no-session";
    }

    const idleMs = Date.now() - session.time.updated;
    if (idleMs < idleThresholdMs) {
      return "skipped:idle";
    }

    // Build the event and check cooldown before prompting.
    const event: ActionableEvent = {
      type: "ci_failure",
      repo,
      repoFullName: repo,
      prNumber,
      prTitle: "", // not known here; the prompt will omit the title line
      headSha,
      headRef: branch,
      baseRef: "",
      message: `CI checks still failing (watchdog): ${failNames.join(", ")}`,
      htmlUrl: `https://github.com/${repo}/pull/${prNumber}/checks`,
      sender: "watchdog",
      timestamp: new Date().toISOString(),
    };

    const cooldownKey = this.cooldownKeyFor(event);
    if (cooldownKey && this.isInCooldown(cooldownKey)) {
      return "skipped:cooldown";
    }

    const prompt = buildPrompt(event);
    try {
      if (cooldownKey) this.setCooldown(cooldownKey);
      await client.promptAsync(mapped.sessionID, { parts: [{ type: "text", text: prompt }] });
      logger.info(`watchdog: re-prompted session ${mapped.sessionID} for ${repo}#${prNumber} (idle ${(idleMs / 60_000).toFixed(1)}min)`, {
        type: "ci_failure",
        failNames,
      });
      return "prompted";
    } catch (err) {
      logger.error(`watchdog: failed to prompt session ${mapped.sessionID}`, err);
      return "skipped:no-session";
    }
  }

  // Called by the watchdog when a PR is unmergable (mergeable_state is
  // "conflicted" or "dirty"). Finds the mapped session and prompts it to
  // rebase on the base branch and resolve conflicts, IF the session is idle
  // past the threshold (so we don't interrupt active work). Uses a separate
  // cooldown key namespace (`merge_conflict`) so a rebase prompt doesn't
  // interfere with a ci_failure prompt for the same PR.
  // Returns "prompted" | "skipped:idle" | "skipped:no-session" | "skipped:cooldown"
  async repromptForMergeConflict(
    repo: string,
    prNumber: number,
    branch: string,
    headSha: string,
    baseRef: string,
    idleThresholdMs: number,
  ): Promise<string> {
    const repoConfig = this.deps.repos[repo];
    if (!repoConfig) return "skipped:no-session";

    const mapped = this.deps.sessionMap.lookup(repo, { prNumber });
    if (!mapped) return "skipped:no-session";

    let client: OpencodeClient;
    try {
      const server = await this.deps.serverManager.ensure(repoConfig.workdir, repoConfig.serverUrl, repoConfig.serverPassword);
      client = server.client;
    } catch (err) {
      logger.error(`watchdog: could not reach opencode server for ${repo}`, err);
      return "skipped:no-session";
    }

    let session: Session;
    try {
      session = await client.getSession(mapped.sessionID);
    } catch {
      logger.warn(`watchdog: mapped session ${mapped.sessionID} no longer exists for ${repo}#${prNumber}`);
      this.deps.sessionMap.delete(mapped.sessionID);
      await this.deps.sessionMap.persist();
      return "skipped:no-session";
    }

    const idleMs = Date.now() - session.time.updated;
    if (idleMs < idleThresholdMs) {
      return "skipped:idle";
    }

    // Distinct cooldown key from ci_failure so a merge-conflict prompt and a
    // CI-failure prompt for the same PR don't suppress each other.
    const cooldownKey = `${repo}:merge_conflict:${prNumber}`;
    if (this.isInCooldown(cooldownKey)) {
      return "skipped:cooldown";
    }

    const prompt = [
      `Merge conflict detected on ${repo}#${prNumber}.`,
      ``,
      `Branch "${branch}" has conflicts with the base branch "${baseRef}" and cannot be merged cleanly.`,
      `Head commit: ${headSha}`,
      `URL: https://github.com/${repo}/pull/${prNumber}`,
      ``,
      `Rebase your branch on "${baseRef}" and resolve the conflicts, then push the updated branch. If the conflicts are non-trivial (e.g. the branch has diverged significantly), consider merging "${baseRef}" into "${branch}" and resolving in your worktree rather than abandoning the PR. After resolving, verify CI passes before requesting review.`,
    ].join("\n");

    try {
      this.setCooldown(cooldownKey);
      await client.promptAsync(mapped.sessionID, { parts: [{ type: "text", text: prompt }] });
      logger.info(`watchdog: re-prompted session ${mapped.sessionID} for ${repo}#${prNumber} merge conflict (idle ${(idleMs / 60_000).toFixed(1)}min)`);
      return "prompted";
    } catch (err) {
      logger.error(`watchdog: failed to prompt session ${mapped.sessionID} for merge conflict`, err);
      return "skipped:no-session";
    }
  }
}

export function buildPrompt(event: ActionableEvent): string {
  const lines = [
    `A new event needs your attention on ${event.repoFullName}.`,
    ``,
    `Event: ${event.type}`,
    `Details: ${event.message}`,
    `URL: ${event.htmlUrl}`,
  ];
  if (event.prNumber) {
    lines.push(`PR #${event.prNumber}: ${event.prTitle}`);
  }
  if (event.headRef) {
    lines.push(`Branch: ${event.headRef}`);
  }
  if (event.headSha) {
    lines.push(`Commit: ${event.headSha}`);
  }
  lines.push(``);
  lines.push(
    event.headRef
      ? `Investigate this and push a fix to the branch "${event.headRef}".`
      : `Investigate this and push a fix.`,
  );
  return lines.join("\n");
}

export function buildSessionTitle(event: ActionableEvent): string {
  if (event.prNumber) return `${event.repoFullName}#${event.prNumber} — ${event.type}`;
  return `${event.repoFullName} — ${event.type}`;
}
