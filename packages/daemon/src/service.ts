import { existsSync } from "node:fs";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./config.js";
import { logger } from "./logger.js";

// Resolve the daemon entry script. When running from the CLI's bundled
// binary (bin/opencode-observer.js), import.meta.dirname is bin/ and the
// daemon dist is at ../packages/daemon/dist/index.js. When running from the
// daemon's own dist (packages/daemon/dist/index.js), it's index.js in the
// same directory.
function resolveDaemonScript(): string | null {
  const candidates = [
    // Running from daemon's own dist
    join(import.meta.dirname ?? ".", "index.js"),
    // Running from CLI dist (packages/cli/dist/)
    join(import.meta.dirname ?? ".", "..", "..", "daemon", "dist", "index.js"),
    // Running from bundled CLI (bin/)
    join(import.meta.dirname ?? ".", "..", "packages", "daemon", "dist", "index.js"),
    // Running from repo root
    join(process.cwd(), "packages", "daemon", "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type ServiceStatus = {
  running: boolean;
  pid: number | null;
  platform: string;
};

function getPidFile(): string {
  return join(getConfigDir(), "daemon.pid");
}

async function writePid(pid: number): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
  await writeFile(getPidFile(), String(pid), "utf-8");
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(getPidFile(), "utf-8");
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

async function removePid(): Promise<void> {
  try {
    await unlink(getPidFile());
  } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function installService(): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    await installLaunchd();
  } else if (os === "linux") {
    await installSystemd();
  } else if (os === "win32") {
    logger.info("Windows service installation requires administrator privileges");
    logger.info("Use 'sc create' or nssm to register the daemon as a Windows service");
  } else {
    logger.warn(`Service installation not supported on ${os}`);
  }
}

async function installLaunchd(): Promise<void> {
  const nodePath = process.execPath;
  const daemonScript = resolveDaemonScript() ?? join(import.meta.dirname ?? ".", "index.js");
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.opencode.observer.daemon.plist");
  const logDir = join(homedir(), "Library", "Logs", "opencode-observer");

  await mkdir(plistDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opencode.observer.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonScript}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/stderr.log</string>
</dict>
</plist>`;

  await writeFile(plistPath, plist, "utf-8");
  logger.info(`LaunchAgent installed at ${plistPath}`);
  logger.info("Run 'launchctl load' to start, or use 'opencode-observer daemon start'");
}

async function installSystemd(): Promise<void> {
  const nodePath = process.execPath;
  const daemonScript = resolveDaemonScript() ?? join(import.meta.dirname ?? ".", "index.js");
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, "opencode-observer.service");

  await mkdir(unitDir, { recursive: true });

  const unit = `[Unit]
Description=OpenCode GitHub Observer Daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${nodePath} ${daemonScript}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;

  await writeFile(unitPath, unit, "utf-8");
  logger.info(`Systemd unit installed at ${unitPath}`);
  logger.info("Run 'systemctl --user enable --now opencode-observer' to start");
}

export async function uninstallService(): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.opencode.observer.daemon.plist");
    if (existsSync(plistPath)) {
      await unlink(plistPath);
      logger.info("LaunchAgent uninstalled");
    }
  } else if (os === "linux") {
    const unitPath = join(homedir(), ".config", "systemd", "user", "opencode-observer.service");
    if (existsSync(unitPath)) {
      await unlink(unitPath);
      logger.info("Systemd unit uninstalled");
    }
  }
}

export async function startDaemon(): Promise<void> {
  const pid = await readPid();
  if (pid && isProcessAlive(pid)) {
    logger.info(`Daemon already running (PID ${pid})`);
    return;
  }

  const { spawn } = await import("node:child_process");
  const daemonScript = resolveDaemonScript();
  if (!daemonScript) {
    logger.error("Could not find daemon script (dist/index.js). Run 'npm run build' first.");
    return;
  }
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  if (child.pid) {
    await writePid(child.pid);
    logger.info(`Daemon started (PID ${child.pid})`);
  }
}

export async function stopDaemon(): Promise<void> {
  const pid = await readPid();
  if (!pid || !isProcessAlive(pid)) {
    logger.info("Daemon is not running");
    await removePid();
    return;
  }

  process.kill(pid, "SIGTERM");
  await removePid();
  logger.info(`Daemon stopped (PID ${pid})`);
}

export async function getDaemonStatus(): Promise<ServiceStatus> {
  const pid = await readPid();
  const running = pid !== null && isProcessAlive(pid);
  return {
    running,
    pid: running ? pid : null,
    platform: platform(),
  };
}
