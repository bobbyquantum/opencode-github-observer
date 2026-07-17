import type { OpencodeClient } from "./opencode/client.js";
import type { Session, ToolPart } from "./opencode/types.js";
import { logger } from "./logger.js";

export type StallConfig = {
  // A tool that has been "running" longer than this (ms) is considered stalled.
  thresholdMs: number;
  // Only scan sessions whose directory matches one of these repo worktree hints
  // (derived from configured repos). Empty = scan all.
  directoryHints: string[];
  // When true, abort stalled sessions instead of just logging.
  abort: boolean;
};

export const DEFAULT_STALL_CONFIG: StallConfig = {
  thresholdMs: 30 * 60 * 1000, // 30 minutes
  directoryHints: [],
  abort: true,
};

export type StallFinding = {
  sessionID: string;
  sessionTitle: string;
  directory: string;
  stalledTools: Array<{ tool: string; command: string; runningForMs: number }>;
};

export type StallDetectionResult = {
  findings: StallFinding[];
  aborted: string[];
};

export async function detectStalls(
  client: OpencodeClient,
  config: StallConfig,
): Promise<StallDetectionResult> {
  const sessions = await client.listSessions();
  const now = Date.now();

  // Filter to sessions that match our directory hints (if any), and are busy
  // or were recently active (don't scan fully idle ancient sessions).
  const candidates = sessions.filter((s) => {
    if (config.directoryHints.length > 0) {
      const matches = config.directoryHints.some((h) => s.directory.includes(h));
      if (!matches) return false;
    }
    // Only check sessions updated in the last 24h — older ones are already
    // abandoned, not stalled.
    const ageMs = now - s.time.updated;
    return ageMs < 24 * 60 * 60 * 1000;
  });

  const findings: StallFinding[] = [];

  for (const session of candidates) {
    try {
      const messages = await client.messages(session.id);
      const stalledTools: StallFinding["stalledTools"] = [];

      for (const msg of messages) {
        for (const part of msg.parts) {
          if (part.type !== "tool") continue;
          const toolPart = part as ToolPart;
          if (toolPart.state?.status !== "running") continue;
          const startTime = toolPart.state.time?.start;
          if (typeof startTime !== "number") continue;

          const runningForMs = now - startTime;
          if (runningForMs < config.thresholdMs) continue;

          const command = String(
            (toolPart.state.input as { command?: unknown } | undefined)?.command ?? "",
          );
          stalledTools.push({
            tool: toolPart.tool,
            command: command.slice(0, 120),
            runningForMs,
          });
        }
      }

      if (stalledTools.length > 0) {
        findings.push({
          sessionID: session.id,
          sessionTitle: session.title,
          directory: session.directory,
          stalledTools,
        });
      }
    } catch {
      // Skip sessions we can't read.
    }
  }

  // Abort stalled sessions if configured.
  const aborted: string[] = [];
  if (config.abort) {
    for (const finding of findings) {
      try {
        await client.abortSession(finding.sessionID);
        aborted.push(finding.sessionID);
        logger.warn(
          `Aborted stalled session ${finding.sessionID} (${finding.sessionTitle})`,
          {
            stalledTools: finding.stalledTools.length,
            longestRunningMs: Math.max(...finding.stalledTools.map((t) => t.runningForMs)),
          },
        );
      } catch (err) {
        logger.error(`Failed to abort stalled session ${finding.sessionID}`, err);
      }
    }
  } else {
    for (const finding of findings) {
      logger.warn(`Stalled session detected: ${finding.sessionID} (${finding.sessionTitle})`, {
        stalledTools: finding.stalledTools.length,
        longestRunningMin: Math.round(Math.max(...finding.stalledTools.map((t) => t.runningForMs)) / 60000),
      });
    }
  }

  return { findings, aborted };
}

// Builds the directory hints from the repos config. Includes the workdir,
// repo name, and the opencode worktree base directories (since worktree
// sessions run in ~/.local/share/opencode/worktree/<hash>/<branch-name>).
export function buildDirectoryHints(repos: Record<string, { workdir: string }>): string[] {
  const hints: string[] = [];
  for (const [fullName, repoConfig] of Object.entries(repos)) {
    hints.push(repoConfig.workdir);
    const repoName = fullName.split("/")[1];
    if (repoName) hints.push(repoName);
  }
  // Opencode worktree directories — sessions for PR branches live here.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  hints.push(`${home}/.local/share/opencode/worktree`);
  // T3 Code worktree directories.
  hints.push(`${home}/.t3/worktrees`);
  return hints;
}