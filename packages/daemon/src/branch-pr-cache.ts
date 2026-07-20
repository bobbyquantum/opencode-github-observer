import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import { logger } from "./logger.js";

// Maps repo -> branch -> { prNumber, headSha, updatedAt }.
// Persisted to disk so the daemon survives restarts and CI failures arriving
// hours after the originating `gh pr create` can be resolved to a PR without
// hitting the GitHub API every time.
export type BranchPrEntry = {
  prNumber: number;
  headSha?: string;
  updatedAt: string;
};

export type BranchPrMap = Record<string, Record<string, BranchPrEntry>>;

function getBranchPrPath(): string {
  return join(getConfigDir(), "branch-pr.json");
}

export class BranchPrCache {
  private map: BranchPrMap = {};
  // Reverse indexes for O(1) lookups by sha and by PR number. Rebuilt lazily
  // on load/mutation. Keyed by `${repo}:${sha}` and `${repo}:${prNumber}`.
  private shaIndex = new Map<string, { branch: string; prNumber: number; headSha: string }>();
  private prIndex = new Map<string, { branch: string; prNumber: number; headSha?: string; updatedAt: string }>();

  constructor(private persistPath: string = getBranchPrPath()) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, "utf-8");
      this.map = JSON.parse(raw) as BranchPrMap;
    } catch {
      this.map = {};
    }
    this.rebuildIndexes();
  }

  async persist(): Promise<void> {
    try {
      await mkdir(join(this.persistPath, ".."), { recursive: true });
      await writeFile(this.persistPath, JSON.stringify(this.map, null, 2), "utf-8");
    } catch (err) {
      logger.warn("Failed to persist branch-pr cache", err);
    }
  }

  // Records / refreshes a branch -> PR mapping. Optionally updates headSha.
  record(repo: string, branch: string, prNumber: number, headSha?: string): void {
    if (!this.map[repo]) this.map[repo] = {};
    const existing = this.map[repo][branch];
    this.map[repo][branch] = {
      prNumber,
      headSha: headSha ?? existing?.headSha,
      updatedAt: new Date().toISOString(),
    };
    this.rebuildIndexes();
  }

  lookupByBranch(repo: string, branch: string): BranchPrEntry | undefined {
    return this.map[repo]?.[branch];
  }

  // Reverse lookup: find a branch by headSha (O(1) via reverse index).
  lookupBySha(repo: string, headSha: string): BranchPrEntry & { branch: string } | undefined {
    const hit = this.shaIndex.get(`${repo}:${headSha}`);
    if (!hit) return undefined;
    return { ...hit, updatedAt: this.prIndex.get(`${repo}:${hit.prNumber}`)?.updatedAt ?? "" };
  }

  // Looks up the entry by PR number (O(1) via reverse index).
  lookupByPr(repo: string, prNumber: number): BranchPrEntry & { branch: string } | undefined {
    const hit = this.prIndex.get(`${repo}:${prNumber}`);
    if (!hit) return undefined;
    return { ...hit, prNumber };
  }

  deleteBranch(repo: string, branch: string): void {
    if (this.map[repo]) delete this.map[repo][branch];
    if (this.map[repo] && Object.keys(this.map[repo]).length === 0) delete this.map[repo];
    this.rebuildIndexes();
  }

  listForRepo(repo: string): Array<BranchPrEntry & { branch: string }> {
    const branches = this.map[repo];
    if (!branches) return [];
    return Object.entries(branches).map(([branch, entry]) => ({ ...entry, branch }));
  }

  clear(): void {
    this.map = {};
    this.shaIndex.clear();
    this.prIndex.clear();
  }

  private rebuildIndexes(): void {
    this.shaIndex.clear();
    this.prIndex.clear();
    for (const [repo, branches] of Object.entries(this.map)) {
      for (const [branch, entry] of Object.entries(branches)) {
        if (entry.headSha) {
          this.shaIndex.set(`${repo}:${entry.headSha}`, {
            branch,
            prNumber: entry.prNumber,
            headSha: entry.headSha,
          });
        }
        this.prIndex.set(`${repo}:${entry.prNumber}`, {
          branch,
          prNumber: entry.prNumber,
          ...(entry.headSha ? { headSha: entry.headSha } : {}),
          updatedAt: entry.updatedAt,
        });
      }
    }
  }
}