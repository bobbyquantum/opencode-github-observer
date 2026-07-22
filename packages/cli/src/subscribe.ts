import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { OpencodeClient } from "@opencode-observer/daemon";

function getConfigDir(): string {
  return join(homedir(), ".config", "opencode-observer");
}

function getSessionMapPath(): string {
  return join(getConfigDir(), "sessions.json");
}

function getBranchPrPath(): string {
  return join(getConfigDir(), "branch-pr.json");
}

type SessionRecord = {
  sessionID: string;
  repo: string;
  branch?: string;
  headSha?: string;
  prNumber?: number;
  updatedAt: string;
};

// Reads the OpenChamber managed-opencode record to find the current server port.
async function discoverServerUrl(): Promise<{ url: string; password?: string } | null> {
  const pidEnv = process.env.OPENCODE_PID;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!pidEnv) return null;
  try {
    const recordPath = join(homedir(), ".config", "openchamber", "managed-opencode", `${pidEnv}.json`);
    const raw = await readFile(recordPath, "utf-8");
    const record = JSON.parse(raw) as { port: number };
    return { url: `http://127.0.0.1:${record.port}`, password };
  } catch {
    return null;
  }
}

// Finds the most recently updated primary session in the given worktree.
async function findCurrentSession(workdir: string, serverUrl: string, password?: string): Promise<string | null> {
  const client = new OpencodeClient({
    baseUrl: serverUrl,
    ...(password ? { password } : {}),
    directory: workdir,
  });
  try {
    const sessions = await client.listSessions();
    const primary = sessions
      .filter((s) => !s.parentID)
      .sort((a, b) => b.time.updated - a.time.updated);
    return primary[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function subscribeCommand(args: string[]): Promise<void> {
  // Parse args: --repo owner/repo --pr 1234 --branch foo [--session ses_xxx] [--workdir /path]
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const repo = getArg("repo");
  const prStr = getArg("pr");
  const branch = getArg("branch");
  const sessionArg = getArg("session");
  const workdirArg = getArg("workdir");

  if (!repo) {
    console.error("Usage: opencode-observer subscribe --repo <owner/repo> --pr <number> [--branch <name>] [--session <id>] [--workdir <path>]");
    console.error("");
    console.error("Subscribes the current opencode session to CI/review events for a PR.");
    console.error("Run this from within your worktree so the session is auto-detected.");
    process.exit(1);
  }

  const prNumber = prStr ? parseInt(prStr, 10) : undefined;
  if (!prNumber && !branch) {
    console.error("Error: provide --pr <number> and/or --branch <name>");
    process.exit(1);
  }

  // Resolve the session ID.
  let sessionID = sessionArg;
  if (!sessionID) {
    const workdir = workdirArg ?? process.cwd();
    const server = await discoverServerUrl();
    if (!server) {
      console.error("Error: could not discover opencode server. Provide --session <id> explicitly.");
      process.exit(1);
    }
    sessionID = await findCurrentSession(workdir, server.url, server.password) ?? undefined;
    if (!sessionID) {
      console.error("Error: could not find a session in the current worktree. Provide --session <id> explicitly.");
      process.exit(1);
    }
    console.log(`Auto-detected session: ${sessionID}`);
  }

  // Read existing session map.
  const mapPath = getSessionMapPath();
  let map: SessionRecord[] = [];
  try {
    map = JSON.parse(await readFile(mapPath, "utf-8")) as SessionRecord[];
  } catch {
    // No existing map.
  }

  // Enforce one PR → one session: remove any existing mapping for this PR
  // number (even if it's a different session). Also remove any existing
  // mapping for THIS session (re-subscribe to a different PR).
  const before = map.length;
  map = map.filter((r) => {
    if (r.sessionID === sessionID) return false; // re-subscribing this session
    if (prNumber && r.prNumber === prNumber) return false; // PR already linked to another session
    return true;
  });
  const removedCount = before - map.length;
  if (removedCount > 0) {
    console.log(`Unlinked ${removedCount} previous mapping(s) for this PR/session.`);
  }

  // Add the new mapping.
  const record: SessionRecord = {
    sessionID,
    repo,
    ...(branch ? { branch } : {}),
    ...(prNumber ? { prNumber } : {}),
    updatedAt: new Date().toISOString(),
  };
  map.push(record);

  await mkdir(getConfigDir(), { recursive: true });
  await writeFile(mapPath, JSON.stringify(map, null, 2), "utf-8");

  // Also update the branch-pr cache so the watchdog and enrichment work.
  if (branch && prNumber) {
    const cachePath = getBranchPrPath();
    let cache: Record<string, Record<string, { prNumber: number; headSha?: string; updatedAt: string }>> = {};
    try {
      cache = JSON.parse(await readFile(cachePath, "utf-8"));
    } catch {
      // No existing cache.
    }
    if (!cache[repo]) cache[repo] = {};
    cache[repo][branch] = { prNumber, updatedAt: new Date().toISOString() };
    await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  }

  console.log(`Subscribed session ${sessionID} to ${repo}${prNumber ? ` PR #${prNumber}` : ""}${branch ? ` branch ${branch}` : ""}`);
  console.log("CI failures and review comments for this PR will now be routed to your session.");
}
