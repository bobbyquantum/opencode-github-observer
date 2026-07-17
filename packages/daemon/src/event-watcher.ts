import type { Event, ToolPart } from "./opencode/types.js";
import type { SessionMap } from "./session-map.js";
import { logger } from "./logger.js";

export type WatcherState = {
  repo: string;
  currentBranch: string;
  sessionMap: SessionMap;
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
        const prNumberMatch = output.match(PR_URL_RE);
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

  constructor(
    private repo: string,
    private client: { subscribeEvents: (signal?: AbortSignal) => AsyncGenerator<Event, void, unknown> },
    private sessionMap: SessionMap,
  ) {}

  async start(): Promise<void> {
    this.abort = new AbortController();
    const state: WatcherState = {
      repo: this.repo,
      currentBranch: "",
      sessionMap: this.sessionMap,
    };

    // Don't let the watcher crash the daemon if the stream errors; reconnect
    // is handled by the caller re-starting if desired.
    try {
      for await (const event of this.client.subscribeEvents(this.abort.signal)) {
        const next = handleEvent(event, state);
        if (next !== undefined) state.currentBranch = next;
      }
    } catch (err) {
      if (!this.abort.signal.aborted) {
        logger.warn(`[${this.repo}] event stream ended`, err);
      }
    }
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }
}
