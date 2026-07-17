import type { ActionableEvent, RepoConfig } from "@opencode-observer/shared";
import { logger } from "./logger.js";
import { SessionMap } from "./session-map.js";
import { OpencodeServerManager } from "./server-manager.js";
import type { OpencodeClient } from "./opencode/client.js";
import type { Session } from "./opencode/types.js";

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
};

const SEARCH_SESSION_LIMIT = 20;

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  constructor(private deps: SessionManagerDeps) {}

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
      sessionID = await this.resolveSessionID(client, event);
    } catch (err) {
      logger.error(`Could not resolve session for ${event.repo}`, err);
      return;
    }

    const info =
      this.sessions.get(sessionID) ??
      ({
        sessionID,
        repo: event.repo,
        prNumber: event.prNumber,
        headRef: event.headRef,
        status: "idle" as SessionStatus,
        lastEvent: null,
        startedAt: new Date().toISOString(),
      } satisfies SessionInfo);
    info.lastEvent = event;
    info.status = "investigating";
    this.sessions.set(sessionID, info);

    const prompt = buildPrompt(event);
    try {
      info.status = "fixing";
      await client.promptAsync(sessionID, { parts: [{ type: "text", text: prompt }] });
      logger.info(`Prompted session ${sessionID} for ${event.repo}#${event.prNumber || event.headRef}`, {
        type: event.type,
      });
    } catch (err) {
      info.status = "error";
      logger.error(`Failed to prompt session ${sessionID}`, err);
    }
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
  //   1. Matching the PR branch name against session worktree directories
  //      (e.g. branch "opencode/hidden-comet" → directory contains "hidden-comet")
  //   2. Matching the repo name or PR number against session titles
  //   3. Scanning message text for branch / PR / URL mentions
  // Prefers primary sessions (no parentID) over subagent sessions, and the
  // most recently updated session wins.
  async searchSessions(client: OpencodeClient, event: ActionableEvent): Promise<Session | null> {
    const sessions = await client.listSessions();
    const repoName = event.repo.split("/")[1] ?? "";

    // Derive a worktree directory hint from the branch name. OpenCode worktree
    // dirs are named after the branch's last path segment, e.g. branch
    // "opencode/hidden-comet" → worktree dir ".../hidden-comet".
    const branchHint = event.headRef ? event.headRef.split("/").pop() ?? "" : "";

    const score = (s: Session): number => {
      let score = 0;
      // Primary sessions are strongly preferred over subagents.
      if (!s.parentID) score += 1000;
      // Directory match by branch hint is the strongest signal.
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

    const candidates = sessions
      .map((s) => ({ s, score: score(s) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_SESSION_LIMIT);

    if (candidates.length === 0 || candidates[0].score < 100) {
      // No strong directory/title match — fall back to message content search.
      return this.searchByMessages(client, sessions, event, repoName);
    }

    return candidates[0].s;
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

    for (const session of candidates) {
      try {
        const messages = await client.messages(session.id);
        const hit = messages.some((m) =>
          m.parts.some((p) => p.type === "text" && needles.some((n) => (p as { text?: string }).text?.includes(n))),
        );
        if (hit) return session;
      } catch {
        // Skip sessions we can't read.
      }
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
