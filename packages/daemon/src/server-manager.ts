import { spawn, type ChildProcess } from "node:child_process";
import { OpencodeClient } from "./opencode/client.js";
import { logger } from "./logger.js";

export type ManagedServer = {
  client: OpencodeClient;
  url: string;
  process?: ChildProcess;
};

const BASE_PORT = 4096;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 200;

export class OpencodeServerManager {
  private managed = new Map<string, ManagedServer>();
  private nextPort = BASE_PORT;

  constructor(private opencodeCommand: string) {}

  async ensure(workdir: string, serverUrl?: string, serverPassword?: string): Promise<ManagedServer> {
    const existing = this.managed.get(workdir);
    if (existing) return existing;

    if (serverUrl) {
      try {
        const client = new OpencodeClient({ baseUrl: serverUrl, ...(serverPassword ? { password: serverPassword } : {}) });
        await this.waitForHealth(client);
        const server: ManagedServer = { client, url: serverUrl };
        this.managed.set(workdir, server);
        logger.info(`Using configured opencode server ${serverUrl} for ${workdir}`);
        return server;
      } catch {
        logger.warn(`Configured server ${serverUrl} not reachable, trying auto-discovery`);
      }
    }

    // Auto-discover a running opencode server (e.g. managed by OpenChamber)
    // by scanning running processes for "opencode serve" and extracting the port.
    const discovered = await this.discoverRunningServer(serverPassword);
    if (discovered) {
      this.managed.set(workdir, discovered);
      logger.info(`Auto-discovered opencode server at ${discovered.url} for ${workdir}`);
      return discovered;
    }

    const server = await this.spawnServer(workdir);
    this.managed.set(workdir, server);
    return server;
  }

  getClient(workdir: string): OpencodeClient | undefined {
    return this.managed.get(workdir)?.client;
  }

  // Scans running processes for "opencode serve" and extracts the port.
  // This handles the case where an external manager (e.g. OpenChamber) has
  // already started a server with a dynamic port.
  async discoverRunningServer(password?: string): Promise<ManagedServer | null> {
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
        const client = new OpencodeClient({ baseUrl: url, ...(password ? { password } : {}) });
        try {
          await this.waitForHealth(client);
          return { client, url };
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
      if (server.process) {
        try {
          server.process.kill("SIGTERM");
          logger.info(`Stopped opencode server for ${workdir}`);
        } catch {}
      }
    }
    this.managed.clear();
  }

  private async spawnServer(workdir: string): Promise<ManagedServer> {
    for (let attempt = 0; attempt < 20; attempt++) {
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

      const client = new OpencodeClient({ baseUrl: url });
      try {
        await this.waitForHealth(client);
        logger.info(`Started opencode server for ${workdir} at ${url}`);
        return { client, url, process: child };
      } catch {
        // Port didn't work or server didn't come up; clean up and try next.
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    throw new Error(`Could not start opencode server for ${workdir}`);
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
