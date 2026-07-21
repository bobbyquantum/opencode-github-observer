import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { OpencodeClient } from "./opencode/client.js";
import { logger } from "./logger.js";

export type ManagedServer = {
  client: OpencodeClient;
  url: string;
  process?: ChildProcess;
  // True when the daemon spawned this server itself (and should stop it on
  // shutdown). False for servers managed externally (e.g. by OpenChamber).
  spawned: boolean;
  // When the cached server was last validated as healthy. Used to skip
  // redundant health checks within a short window.
  lastValidatedAt: number;
};

const BASE_PORT = 4096;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;
// Skip re-validating a cached server if it was validated within this window.
// Avoids a health-check round-trip on every ensure() call while still
// detecting stale servers within a minute.
const REVALIDATE_INTERVAL_MS = 60_000;

// OpenChamber drops a JSON file per running opencode server at
// ~/.config/openchamber/managed-opencode/<pid>.json containing the port,
// binary path, and start time. This is the most reliable source of truth
// for the current server — env vars (OPENCODE_PID) point us at the file.
function managedOpencodeDir(): string {
  return join(homedir(), ".config", "openchamber", "managed-opencode");
}

type ManagedOpencodeRecord = {
  pid: number;
  port: number;
  binary: string;
  startedAt: string;
};

async function readManagedOpencodeRecord(pid: number): Promise<ManagedOpencodeRecord | null> {
  const path = join(managedOpencodeDir(), `${pid}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as ManagedOpencodeRecord;
  } catch {
    return null;
  }
}

export class OpencodeServerManager {
  private managed = new Map<string, ManagedServer>();
  private nextPort = BASE_PORT;

  constructor(private opencodeCommand: string) {}

  // Returns a healthy opencode server for the given workdir. Re-validates the
  // cached server periodically so external restarts (e.g. OpenChamber
  // restarting the server on a new port) are picked up automatically.
  async ensure(workdir: string, serverUrl?: string, serverPassword?: string): Promise<ManagedServer> {
    const existing = this.managed.get(workdir);
    const now = Date.now();
    // Re-use the cached server if it was validated recently. This avoids a
    // health-check round-trip on every ensure() call (which fires for every
    // webhook event) while still detecting stale servers within a minute.
    if (existing && now - existing.lastValidatedAt < REVALIDATE_INTERVAL_MS) {
      return existing;
    }

    // If we have a cached server, re-validate it with a quick health check.
    // If it's still healthy, refresh lastValidatedAt and return it.
    if (existing) {
      try {
        await existing.client.health();
        existing.lastValidatedAt = now;
        return existing;
      } catch {
        logger.info(`Cached opencode server for ${workdir} is no longer reachable; re-discovering`);
        this.managed.delete(workdir);
        // Fall through to discovery.
      }
    }

    // 1. Try the explicitly configured serverUrl (if set).
    if (serverUrl) {
      try {
        const client = new OpencodeClient({
          baseUrl: serverUrl,
          // Scope all opencode API calls to the configured workdir's project.
          // This makes listSessions return sessions across all worktrees of
          // the project (e.g. merry-gopher, disco-badger), not just the
          // opencode server's CWD.
          ...(serverPassword ? { password: serverPassword } : {}),
          ...(workdir ? { directory: workdir } : {}),
        });
        await this.waitForHealth(client);
        const server: ManagedServer = { client, url: serverUrl, spawned: false, lastValidatedAt: now };
        this.managed.set(workdir, server);
        logger.info(`Using configured opencode server ${serverUrl} for ${workdir}`);
        return server;
      } catch {
        logger.warn(`Configured server ${serverUrl} not reachable, trying auto-discovery`);
      }
    }

    // 2. Auto-discover via OpenChamber's managed-opencode record (most
    //    reliable — uses the OPENCODE_PID env var that OpenChamber sets).
    const discovered = await this.discoverRunningServer(workdir, serverPassword);
    if (discovered) {
      this.managed.set(workdir, { ...discovered, lastValidatedAt: now });
      logger.info(`Auto-discovered opencode server at ${discovered.url} for ${workdir}`);
      return { ...discovered, lastValidatedAt: now };
    }

    // 3. Last resort: spawn our own server.
    const server = await this.spawnServer(workdir);
    this.managed.set(workdir, { ...server, lastValidatedAt: now });
    return { ...server, lastValidatedAt: now };
  }

  getClient(workdir: string): OpencodeClient | undefined {
    return this.managed.get(workdir)?.client;
  }

  // Auto-discovers a running opencode server. Tries in order:
  //   1. OpenChamber managed-opencode record (via OPENCODE_PID env var)
  //   2. Process scan for "opencode serve" (fallback for non-OpenChamber setups)
  // The password is read from the OPENCODE_SERVER_PASSWORD env var when not
  // explicitly provided — OpenChamber sets this env var on the daemon process.
  async discoverRunningServer(workdir: string, password?: string): Promise<ManagedServer | null> {
    const effectivePassword = password ?? process.env.OPENCODE_SERVER_PASSWORD;

    // 1. OpenChamber managed-opencode record.
    const managed = await this.discoverViaManagedRecord(workdir, effectivePassword);
    if (managed) return managed;

    // 2. Process scan fallback.
    return await this.discoverViaProcessScan(workdir, effectivePassword);
  }

  // Reads OPENCODE_PID and the managed-opencode JSON file to find the port.
  // If OPENCODE_PID is stale (the server has restarted with a new PID since
  // the daemon launched), falls back to scanning the managed-opencode
  // directory for the most recent record.
  private async discoverViaManagedRecord(workdir: string, password?: string): Promise<ManagedServer | null> {
    const candidates: Array<{ pid: number; port: number; mtime: number }> = [];

    // 1. The PID from the env var (preferred — it's the one OpenChamber
    //    intended the daemon to use).
    const pidEnv = process.env.OPENCODE_PID;
    if (pidEnv) {
      const pid = parseInt(pidEnv, 10);
      if (Number.isFinite(pid)) {
        const record = await readManagedOpencodeRecord(pid);
        if (record && record.pid === pid) {
          candidates.push({ pid: record.pid, port: record.port, mtime: 0 });
        }
      }
    }

    // 2. Fall back to scanning the managed-opencode directory for any record.
    //    This handles the case where the daemon's OPENCODE_PID env var is
    //    stale (OpenChamber restarted the server with a new PID since the
    //    daemon launched). Pick the most recently modified record.
    if (candidates.length === 0) {
      const dir = managedOpencodeDir();
      try {
        const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
          const path = join(dir, file);
          const record = await readManagedOpencodeRecord(parseInt(file, 10));
          if (!record) continue;
          const st = await stat(path);
          candidates.push({ pid: record.pid, port: record.port, mtime: st.mtimeMs });
        }
      } catch {
        // Directory doesn't exist or isn't readable.
      }
    }

    if (candidates.length === 0) return null;

    // Sort by mtime descending (env-var candidate has mtime=0 so it's last;
    // we check it first via the explicit ordering below).
    candidates.sort((a, b) => b.mtime - a.mtime);

    // Try the env-var candidate first (if it exists), then the newest file.
    const ordered = candidates.find((c) => c.mtime === 0)
      ? [candidates.find((c) => c.mtime === 0)!, ...candidates.filter((c) => c.mtime !== 0)]
      : candidates;

    for (const candidate of ordered) {
      const url = `http://127.0.0.1:${candidate.port}`;
      const client = new OpencodeClient({
        baseUrl: url,
        ...(password ? { password } : {}),
        ...(workdir ? { directory: workdir } : {}),
      });
      try {
        await this.waitForHealth(client);
        return { client, url, spawned: false, lastValidatedAt: Date.now() };
      } catch {
        logger.debug(`watchdog: managed opencode server at ${url} not healthy (pid=${candidate.pid})`);
      }
    }
    return null;
  }

  // Scans running processes for "opencode serve" and extracts the port.
  // Fallback for non-OpenChamber environments where the managed-opencode
  // record isn't available.
  private async discoverViaProcessScan(workdir: string, password?: string): Promise<ManagedServer | null> {
    const { execSync } = await import("node:child_process");
    const cmd = process.platform === "win32" ? 'wmic process where "name like %opencode%" get commandline' : "ps aux";
    try {
      const output = execSync(cmd, { encoding: "utf-8", timeout: 3000 });
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.includes("opencode") || !line.includes("serve") || line.includes("grep")) continue;
        const portMatch = line.match(/--port\s+(\d+)/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);
        const hostMatch = line.match(/--hostname\s+([\d.]+)/);
        const host = hostMatch ? hostMatch[1] : "127.0.0.1";
        const url = `http://${host}:${port}`;
        const client = new OpencodeClient({
          baseUrl: url,
          ...(password ? { password } : {}),
          ...(workdir ? { directory: workdir } : {}),
        });
        try {
          await this.waitForHealth(client);
          return { client, url, spawned: false, lastValidatedAt: Date.now() };
        } catch {
          // This server isn't responding, try the next one.
        }
      }
    } catch {
      // ps not available or no processes found
    }
    return null;
  }

  async stopAll(): Promise<void> {
    for (const [workdir, server] of this.managed) {
      // Only stop servers we spawned ourselves. Externally-managed servers
      // (e.g. OpenChamber's) keep running — the daemon doesn't own them.
      if (server.spawned && server.process) {
        try {
          server.process.kill("SIGTERM");
          logger.info(`Stopped opencode server for ${workdir}`);
        } catch {}
      }
    }
    this.managed.clear();
  }

  private async spawnServer(workdir: string): Promise<ManagedServer> {
    // Fail fast: if the opencode binary is missing or the first couple of
    // ports fail, give up. Previously we retried 20 times, which just spun
    // for minutes before failing anyway.
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = this.nextPort++;
      const url = `http://127.0.0.1:${port}`;
      const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];

      const child = spawn(this.opencodeCommand, args, {
        cwd: workdir,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: { ...process.env },
      });

      child.stdout?.on("data", (data: Buffer) => {
        logger.debug(`[opencode:${workdir}] ${data.toString().trim()}`);
      });
      child.stderr?.on("data", (data: Buffer) => {
        logger.debug(`[opencode:${workdir}] ${data.toString().trim()}`);
      });
      child.on("exit", (code) => {
        logger.debug(`[opencode:${workdir}] exited with code ${code}`);
      });

      const client = new OpencodeClient({
        baseUrl: url,
        ...(workdir ? { directory: workdir } : {}),
      });
      try {
        await this.waitForHealth(client);
        logger.info(`Started opencode server for ${workdir} at ${url}`);
        return { client, url, process: child, spawned: true, lastValidatedAt: Date.now() };
      } catch {
        // Port didn't work or server didn't come up; clean up and try next.
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    throw new Error(`Could not start opencode server for ${workdir} after 3 attempts`);
  }

  private async waitForHealth(client: OpencodeClient): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await client.health();
        return;
      } catch {
        await sleep(HEALTH_POLL_MS);
      }
    }
    throw new Error("opencode server did not become healthy in time");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
