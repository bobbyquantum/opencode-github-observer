import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, validateConfig, type ObserverConfig } from "@opencode-observer/shared";

export function getConfigDir(): string {
  return join(homedir(), ".config", "opencode-observer");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getTokenPath(): string {
  return join(getConfigDir(), "token.json");
}

export function getLogDir(): string {
  const os = platform();
  if (os === "darwin") return join(homedir(), "Library", "Logs", "opencode-observer");
  if (os === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode-observer", "logs");
  return join(homedir(), ".local", "share", "opencode-observer", "logs");
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
}

export async function ensureLogDir(): Promise<void> {
  await mkdir(getLogDir(), { recursive: true });
}

export async function loadConfig(): Promise<ObserverConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    return validateConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: Partial<ObserverConfig>): Promise<void> {
  await ensureConfigDir();
  const existing = await loadConfig();
  // Deep-merge the repos map so adding one repo doesn't wipe the others.
  let repos = existing.repos;
  if (config.repos) {
    repos = { ...existing.repos };
    for (const [name, r] of Object.entries(config.repos)) {
      repos[name] = { ...(repos[name] ?? {}), ...r };
    }
  }
  const merged = { ...existing, ...config, ...(repos !== existing.repos ? { repos } : {}) };
  const validated = validateConfig(merged);
  await writeFile(getConfigPath(), JSON.stringify(validated, null, 2), "utf-8");
}

export async function loadToken(): Promise<string | null> {
  try {
    const raw = await readFile(getTokenPath(), "utf-8");
    const parsed = JSON.parse(raw) as { access_token?: string };
    return parsed.access_token ?? null;
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await ensureConfigDir();
  await writeFile(getTokenPath(), JSON.stringify({ access_token: token }, null, 2), "utf-8");
}

export async function clearToken(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(getTokenPath());
  } catch {}
}
