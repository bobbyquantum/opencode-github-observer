import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.js";
import { getConfigDir } from "./config.js";

export type SessionRecord = {
  sessionID: string;
  repo: string;
  branch?: string;
  headSha?: string;
  prNumber?: number;
  updatedAt: string;
};

export type LookupKey = {
  branch?: string;
  headSha?: string;
  prNumber?: number;
};

function getSessionMapPath(): string {
  return join(getConfigDir(), "sessions.json");
}

export class SessionMap {
  private records = new Map<string, SessionRecord>();
  private lastReloadAt = 0;
  private readonly reloadIntervalMs = 5000; // reload from disk at most every 5s

  constructor(private persistPath: string = getSessionMapPath()) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf-8");
      const arr = JSON.parse(raw) as SessionRecord[];
      this.records.clear();
      for (const rec of arr) {
        if (rec && typeof rec.sessionID === "string") {
          this.records.set(rec.sessionID, rec);
        }
      }
      this.lastReloadAt = Date.now();
    } catch {
      // No persisted map yet — start empty.
    }
  }

  // Reloads the session map from disk if it was modified externally (e.g.
  // by the MCP server's link_pr tool). Called before lookups so the daemon
  // always sees the latest mappings without needing a restart.
  // Merges file records into the in-memory map (file takes precedence) so
  // programmatic records (e.g. from tests or the daemon's own record()
  // calls) aren't lost when the file hasn't been updated.
  async reloadIfStale(): Promise<void> {
    if (Date.now() - this.lastReloadAt < this.reloadIntervalMs) return;
    try {
      const st = await stat(this.persistPath);
      if (st.mtimeMs <= this.lastReloadAt) {
        this.lastReloadAt = Date.now();
        return;
      }
      const raw = await readFile(this.persistPath, "utf-8");
      const arr = JSON.parse(raw) as SessionRecord[];
      // Merge: only add records from the file that aren't already in memory.
      // In-memory records (from the daemon's own record() calls or test setup)
      // take precedence — the file only adds new mappings (e.g. from the MCP
      // server's link_pr tool).
      for (const rec of arr) {
        if (rec && typeof rec.sessionID === "string" && !this.records.has(rec.sessionID)) {
          this.records.set(rec.sessionID, rec);
        }
      }
      this.lastReloadAt = Date.now();
    } catch {
      // File doesn't exist or can't be read — keep in-memory records as-is.
      this.lastReloadAt = Date.now();
    }
  }

  async persist(): Promise<void> {
    try {
      await mkdir(join(this.persistPath, ".."), { recursive: true });
      const arr = Array.from(this.records.values());
      await writeFile(this.persistPath, JSON.stringify(arr, null, 2), "utf-8");
    } catch (err) {
      logger.warn("Failed to persist session map", err);
    }
  }

  record(rec: SessionRecord): void {
    const existing = this.records.get(rec.sessionID);
    const merged: SessionRecord = {
      sessionID: rec.sessionID,
      repo: rec.repo,
      updatedAt: rec.updatedAt,
      branch: rec.branch ?? existing?.branch,
      headSha: rec.headSha ?? existing?.headSha,
      prNumber: rec.prNumber ?? existing?.prNumber,
    };
    this.records.set(rec.sessionID, merged);
  }

  lookup(repo: string, key: LookupKey): SessionRecord | undefined {
    for (const rec of this.records.values()) {
      if (rec.repo !== repo) continue;
      if (key.branch && rec.branch === key.branch) return rec;
      if (key.headSha && rec.headSha === key.headSha) return rec;
      if (key.prNumber !== undefined && rec.prNumber === key.prNumber) return rec;
    }
    return undefined;
  }

  getBySession(sessionID: string): SessionRecord | undefined {
    return this.records.get(sessionID);
  }

  delete(sessionID: string): void {
    this.records.delete(sessionID);
  }

  list(): SessionRecord[] {
    return Array.from(this.records.values());
  }

  clear(): void {
    this.records.clear();
  }
}
