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
  // Instructions appended to every prompt. Configurable via
  // `opencode-observer config set promptInstructions "..."`.
  promptInstructions?: string;
};

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

    let sessionID: string | null;
    try {
      sessionID = await this.resolveSessionID(client, enriched);
    } catch (err) {
      logger.error(`Could not resolve session for ${event.repo}`, err);
      return;
    }

    // No session linked for this PR — skip the event. The agent must run
    // /link-pr to subscribe its session before events get routed.
    if (!sessionID) {
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

    const prompt = buildPrompt(enriched, this.deps.promptInstructions);
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

  // Resolves the session for an event. The session map is the sole source of
  // truth — agents explicitly subscribe their session to a PR via
  // `opencode-observer subscribe` (or the /link-pr command).
  //
  // 1. Look up the session map by branch / headSha / prNumber.
  // 2. If found and the session still exists, use it.
  // 3. If not found, return null — the event is skipped. No new session is
  //    created. The agent must link its session first via /link-pr.
  async resolveSessionID(client: OpencodeClient, event: ActionableEvent): Promise<string | null> {
    const repo = event.repo;
    const existing = this.deps.sessionMap.lookup(repo, {
      ...(event.headRef ? { branch: event.headRef } : {}),
      ...(event.headSha ? { headSha: event.headSha } : {}),
      ...(event.prNumber ? { prNumber: event.prNumber } : {}),
    });

    if (existing) {
      try {
        const session = await client.getSession(existing.sessionID);
        this.recordResolved(session, repo, event);
        return session.id;
      } catch {
        logger.warn(`Mapped session ${existing.sessionID} no longer exists; removing mapping`);
        this.deps.sessionMap.delete(existing.sessionID);
        await this.deps.sessionMap.persist();
      }
    }

    logger.info(`No session linked for ${repo}#${event.prNumber || event.headRef}; skipping event (agent must run /link-pr first)`);
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

  // Extracts incomplete todos from a session's message history. Looks for the
  // last `todowrite` tool call and returns any items with status "in_progress"
  // or "pending". Used by the watchdog to remind agents of unfinished work.
  private async getIncompleteTodos(
    client: OpencodeClient,
    sessionID: string,
  ): Promise<Array<{ status: string; content: string }>> {
    try {
      const messages = await client.messages(sessionID);
      // Walk messages in reverse to find the LAST todowrite tool call.
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        for (const part of msg.parts) {
          if (part.type !== "tool") continue;
          const toolPart = part as { tool: string; state?: { status: string; input?: { todos?: Array<{ status: string; content: string }> } } };
          if (toolPart.tool !== "todowrite") continue;
          const todos = toolPart.state?.input?.todos;
          if (!Array.isArray(todos)) continue;
          // Return only incomplete items.
          return todos.filter((t) => t.status === "in_progress" || t.status === "pending");
        }
      }
    } catch {
      // Can't read messages — no todos to report.
    }
    return [];
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

    // Check if the session left incomplete todos — if so, include them in the
    // re-prompt so the agent knows exactly what it left unfinished.
    const incompleteTodos = await this.getIncompleteTodos(client, mapped.sessionID);

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
      message: incompleteTodos.length > 0
        ? `CI checks still failing (watchdog): ${failNames.join(", ")}\n\nYou also left ${incompleteTodos.length} task(s) unfinished:\n${incompleteTodos.map((t: { status: string; content: string }) => `- [${t.status}] ${t.content}`).join("\n")}`
        : `CI checks still failing (watchdog): ${failNames.join(", ")}`,
      htmlUrl: `https://github.com/${repo}/pull/${prNumber}/checks`,
      sender: "watchdog",
      timestamp: new Date().toISOString(),
    };

    const cooldownKey = this.cooldownKeyFor(event);
    if (cooldownKey && this.isInCooldown(cooldownKey)) {
      return "skipped:cooldown";
    }

    const prompt = buildPrompt(event, this.deps.promptInstructions);
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

    const lines = [
      `Merge conflict detected on ${repo}#${prNumber}.`,
      ``,
      `Branch "${branch}" has conflicts with the base branch "${baseRef}" and cannot be merged cleanly.`,
      `Head commit: ${headSha}`,
      `URL: https://github.com/${repo}/pull/${prNumber}`,
      ``,
      `Rebase your branch on "${baseRef}" and resolve the conflicts, then push the updated branch. If the conflicts are non-trivial (e.g. the branch has diverged significantly), consider merging "${baseRef}" into "${branch}" and resolving in your worktree rather than abandoning the PR. After resolving, verify CI passes before requesting review.`,
    ];
    if (this.deps.promptInstructions) {
      lines.push(``);
      lines.push(this.deps.promptInstructions);
    }
    const prompt = lines.join("\n");

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

export function buildPrompt(event: ActionableEvent, instructions?: string): string {
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
  if (instructions) {
    lines.push(``);
    lines.push(instructions);
  }
  return lines.join("\n");
}

export function buildSessionTitle(event: ActionableEvent): string {
  if (event.prNumber) return `${event.repoFullName}#${event.prNumber} — ${event.type}`;
  return `${event.repoFullName} — ${event.type}`;
}
