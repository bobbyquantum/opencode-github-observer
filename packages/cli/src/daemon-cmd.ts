import { readFile } from "node:fs/promises";
import { getLogDir } from "@opencode-observer/daemon/config";
import {
  getDaemonStatus,
  installService,
  startDaemon,
  stopDaemon,
  uninstallService,
} from "@opencode-observer/daemon/service";

export async function daemonCommand(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "start":
      await startDaemon();
      break;
    case "stop":
      await stopDaemon();
      break;
    case "status": {
      const status = await getDaemonStatus();
      if (status.running) {
        console.log(`Daemon is running (PID ${status.pid})`);
      } else {
        console.log("Daemon is not running");
      }
      console.log(`Platform: ${status.platform}`);
      break;
    }
    case "logs":
      await tailLogs(args.slice(1));
      break;
    case "install":
      await installService();
      break;
    case "uninstall":
      await uninstallService();
      break;
    default:
      console.log("Usage: opencode-observer daemon <start|stop|status|logs|install|uninstall>");
      break;
  }
}

async function tailLogs(args: string[]): Promise<void> {
  const follow = args.includes("-f") || args.includes("--follow");
  const lines = parseInt(args.find((a) => a.startsWith("-n"))?.replace("-n", "") ?? "50", 10);

  const logDir = getLogDir();
  const date = new Date().toISOString().slice(0, 10);
  const logFile = `${logDir}/daemon-${date}.log`;

  try {
    const content = await readFile(logFile, "utf-8");
    const allLines = content.trim().split("\n");
    const tail = allLines.slice(-lines);
    console.log(tail.join("\n"));
  } catch {
    console.log(`No log file found at ${logFile}`);
  }

  if (follow) {
    const { watch } = await import("node:fs");
    console.log("\nWatching for new log entries...");
    const watcher = watch(logFile, () => {});
    watcher.on("change", async () => {
      try {
        const content = await readFile(logFile, "utf-8");
        const allLines = content.trim().split("\n");
        console.log(allLines.slice(-lines).join("\n"));
      } catch {}
    });

    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
  }
}
