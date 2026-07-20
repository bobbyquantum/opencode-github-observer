import type { Event, ToolPart } from "./opencode/types.js";
import type { SessionMap } from "./session-map.js";
import type { BranchPrCache } from "./branch-pr-cache.js";
import { logger } from "./logger.js";

export type WatcherState = {
  repo: string;
  currentBranch: string;
  sessionMap: SessionMap;
  branchPrCache?: BranchPrCache;
};

const SHA_RE = /\b[0-9a-f]{40}\b/;
const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;

// Extracts the pushed branch from a `git push` command. Handles:
//   git push origin feature
//   git push -u origin feature
//   git push origin HEAD:feature
//   git push origin feature:feature
// Returns undefined when the command doesn't name a branch (e.g. bare `git push`).
export function parseBranchFromCommand(command: string): string | undefined {
  if (!/\bgit push\b/.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/);
  const pushIdx = tokens.indexOf("push");
  const rest = tokens.slice(pushIdx + 1).filter((t) => !t.startsWith("-"));
  // rest is like [remote, refspec] or [remote] or [].
  if (rest.length < 2) return undefined;
  const refspec = rest[1];
  const dst = refspec.includes(":") ? refspec.split(":")[1] : refspec;
  if (!dst || dst === "HEAD") return undefined;
  // Strip trailing local-config like refs/heads/.
  const cleaned = dst.replace(/^refs\/heads\//, "");
  return cleaned || undefined;
}

// Pure event handler. Mutates `state.sessionMap` and returns the updated
// current branch (or undefined if unchanged). Exported for unit testing.
export function handleEvent(event: Event, state: WatcherState): string | undefined {
  switch (event.type) {
    case "vcs.branch.updated": {
      const branch = event.properties.branch;
      if (typeof branch === "string" && branch !== state.currentBranch) {
        logger.debug(`[${state.repo}] branch -> ${branch}`);
        return branch;
      }
      return undefined;
    }

    case "message.part.updated": {
      const part = event.properties.part as Partial<ToolPart> | undefined;
      if (!part || part.type !== "tool" || part.tool !== "bash") return undefined;
      if (!part.sessionID) return undefined;
      const state_ = part.state;
      if (!state_ || state_.status !== "completed") return undefined;

      const command = String((state_.input as { command?: unknown } | undefined)?.command ?? "");
      const output = String((state_ as { output?: unknown }).output ?? "");

      if (/\bgit push\b/.test(command) || /\bgh pr create\b/.test(command)) {
        const branch = parseBranchFromCommand(command) ?? state.currentBranch;
        if (!branch) {
          logger.debug(`[${state.repo}] push observed but no branch could be determined`, { command });
          return undefined;
        }
        const headSha = output.match(SHA_RE)?.[0];
        // Only extract a PR number from `gh pr create` output. GitHub's
        // `git push` response sometimes includes a "Create a pull request
        // for '<branch>' on GitHub" URL in the remote output, which would
        // falsely match a PR URL regex even though no PR exists yet.
        const isPrCreate = /\bgh pr create\b/.test(command);
        const prNumberMatch = isPrCreate ? output.match(PR_URL_RE) : null;
        const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

        state.sessionMap.record({
          sessionID: part.sessionID,
          repo: state.repo,
          branch,
          ...(headSha ? { headSha } : {}),
          ...(prNumber !== undefined ? { prNumber } : {}),
          updatedAt: new Date().toISOString(),
        });
        void state.sessionMap.persist();

        // Also record into the branch-pr cache so future CI-failure events
        // on this branch/sha resolve to the PR without hitting the GitHub API.
        if (state.branchPrCache && prNumber !== undefined) {
          state.branchPrCache.record(state.repo, branch, prNumber, headSha);
          void state.branchPrCache.persist();
        }

        logger.info(`[${state.repo}] recorded session ${part.sessionID} -> branch ${branch}`, {
          headSha,
          prNumber,
        });
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

export class EventWatcher {
  private abort: AbortController | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartResolve: (() => void) | null = null;
  private running = false;

  constructor(
    private repo: string,
    private client: { subscribeEvents: (signal?: AbortSignal) => AsyncGenerator<Event, void, unknown> },
    private sessionMap: SessionMap,
    private branchPrCache?: BranchPrCache,
  ) {}

  // Starts the event stream. Reconnects automatically on stream end or error
  // (opencode server restarts, network blips, etc.) with exponential backoff.
  async start(): Promise<void> {
    this.running = true;
    let attempt = 0;
    while (this.running) {
      this.abort = new AbortController();
      const state: WatcherState = {
        repo: this.repo,
        currentBranch: "",
        sessionMap: this.sessionMap,
        ...(this.branchPrCache ? { branchPrCache: this.branchPrCache } : {}),
      };

      try {
        for await (const event of this.client.subscribeEvents(this.abort.signal)) {
          const next = handleEvent(event, state);
          if (next !== undefined) state.currentBranch = next;
        }
        // Stream ended cleanly (e.g. server restarted). Log and reconnect.
        if (this.running) {
          logger.info(`[${this.repo}] event stream ended; reconnecting`);
        }
      } catch (err) {
        if (!this.abort.signal.aborted) {
          logger.warn(`[${this.repo}] event stream error`, err);
        }
      }

      if (!this.running) break;
      // Backoff: 1s, 2s, 4s, ... capped at 30s. Reset on successful stream.
      const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
      attempt++;
      await new Promise<void>((resolve) => {
        this.restartResolve = resolve;
        this.restartTimer = setTimeout(resolve, delay);
      });
      this.restartTimer = null;
      this.restartResolve = null;
    }
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // Resolve any pending backoff promise so start() exits promptly instead
    // of hanging on the sleep timer.
    this.restartResolve?.();
    this.restartResolve = null;
  }
}
