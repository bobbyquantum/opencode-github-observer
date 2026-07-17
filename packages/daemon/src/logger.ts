import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getLogDir, ensureLogDir } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = "info";
let logDirReady = false;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

async function ensureDir(): Promise<void> {
  if (!logDirReady) {
    await ensureLogDir();
    logDirReady = true;
  }
}

function formatMessage(level: LogLevel, message: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (data !== undefined) {
    return `${base} ${typeof data === "string" ? data : JSON.stringify(data)}`;
  }
  return base;
}

export async function log(level: LogLevel, message: string, data?: unknown): Promise<void> {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const formatted = formatMessage(level, message, data);
  console.log(formatted);

  try {
    await ensureDir();
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(getLogDir(), `daemon-${date}.log`);
    appendFileSync(logFile, formatted + "\n");
  } catch {}
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info: (msg: string, data?: unknown) => log("info", msg, data),
  warn: (msg: string, data?: unknown) => log("warn", msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
