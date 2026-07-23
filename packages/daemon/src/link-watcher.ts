import { readFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { OpencodeClient } from "./opencode/client.js";
import { OpencodeServerManager } from "./server-manager.js";
import { SessionMap } from "./session-map.js";
import { logger } from "./logger.js";

// Watches for `.opencode-link.json` files in configured workdirs. When an
// agent runs the /link-pr command, it writes this file (using opencode's
// built-in write tool — no bash, no permission dialogs). The daemon picks it
// up, auto-detects the most recently active session in that worktree, and
// writes the session→PR mapping to the session map.

type LinkFile = {
  repo: string;
  prNumber: number;
  branch?: string;
};

// Processes a single .opencode-link.json file: reads it, finds the current
// session in the worktree, writes the mapping, and deletes the file.
export async function processLinkFile(
  workdir: string,
  serverManager: OpencodeServerManager,
  sessionMap: SessionMap,
  serverUrl?: string,
  serverPassword?: string,
): Promise<boolean> {
  const linkPath = join(workdir, ".opencode-link.json");
  if (!existsSync(linkPath)) return false;

  let link: LinkFile;
  try {
    const raw = await readFile(linkPath, "utf-8");
    link = JSON.parse(raw) as LinkFile;
  } catch (err) {
    logger.warn(`link-watcher: could not read ${linkPath}`, err);
    return false;
  }

  if (!link.repo || !link.prNumber) {
    logger.warn(`link-watcher: ${linkPath} missing repo or prNumber`);
    try { await unlink(linkPath); } catch {}
    return false;
  }

  // Find the most recently active primary session in this worktree.
  let client: OpencodeClient;
  try {
    const server = await serverManager.ensure(workdir, serverUrl, serverPassword);
    client = server.client;
  } catch (err) {
    logger.error(`link-watcher: could not reach opencode server for ${workdir}`, err);
    return false;
  }

  let sessionID: string | null = null;
  try {
    const sessions = await client.listSessions();
    const primary = sessions
      .filter((s) => !s.parentID)
      .sort((a, b) => b.time.updated - a.time.updated);
    sessionID = primary[0]?.id ?? null;
  } catch (err) {
    logger.error(`link-watcher: could not list sessions for ${workdir}`, err);
    return false;
  }

  if (!sessionID) {
    logger.warn(`link-watcher: no active session found in ${workdir}`);
    return false;
  }

  // Write the mapping — one PR per session (remove any existing mapping for
  // this PR or this session).
  const existing = sessionMap.list();
  for (const entry of existing) {
    if (entry.sessionID === sessionID || (link.prNumber && entry.prNumber === link.prNumber)) {
      sessionMap.delete(entry.sessionID);
    }
  }
  sessionMap.record({
    sessionID,
    repo: link.repo,
    prNumber: link.prNumber,
    ...(link.branch ? { branch: link.branch } : {}),
    updatedAt: new Date().toISOString(),
  });
  await sessionMap.persist();

  // Also update the branch-pr cache so enrichment works.
  // (The SessionMap already has the mapping; the branch-pr cache is for
  // PR-number enrichment of CI failures. We update it via the session map's
  // record.)

  // Delete the link file so it's not processed again.
  try { await unlink(linkPath); } catch {}

  logger.info(`link-watcher: linked session ${sessionID} to ${link.repo}#${link.prNumber}${link.branch ? ` (branch ${link.branch})` : ""}`);
  return true;
}

// Scans all configured workdirs for .opencode-link.json files and processes
// them. Called periodically by the daemon.
export async function processLinkFiles(
  repos: Record<string, { workdir: string; serverUrl?: string; serverPassword?: string }>,
  serverManager: OpencodeServerManager,
  sessionMap: SessionMap,
): Promise<void> {
  for (const [_repo, repoConfig] of Object.entries(repos)) {
    try {
      await processLinkFile(
        repoConfig.workdir,
        serverManager,
        sessionMap,
        repoConfig.serverUrl,
        repoConfig.serverPassword,
      );
    } catch (err) {
      logger.debug(`link-watcher: error processing ${repoConfig.workdir}`, err);
    }
  }
}