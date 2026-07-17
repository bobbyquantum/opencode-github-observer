import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

function getSessionMapPath(): string {
  return join(homedir(), ".config", "opencode-observer", "sessions.json");
}

type SessionRecord = {
  sessionID: string;
  repo: string;
  branch?: string;
  headSha?: string;
  prNumber?: number;
  updatedAt: string;
};

export async function sessionsCommand(): Promise<void> {
  let records: SessionRecord[];
  try {
    const raw = await readFile(getSessionMapPath(), "utf-8");
    records = JSON.parse(raw) as SessionRecord[];
  } catch {
    console.log("No session mappings found.");
    console.log('The daemon records these as it watches opencode sessions push branches / create PRs.');
    return;
  }

  if (records.length === 0) {
    console.log("Session map is empty.");
    return;
  }

  // Group by repo for readable output.
  const byRepo = new Map<string, SessionRecord[]>();
  for (const rec of records) {
    const list = byRepo.get(rec.repo) ?? [];
    list.push(rec);
    byRepo.set(rec.repo, list);
  }

  for (const [repo, recs] of byRepo) {
    console.log(`\n${repo}`);
    console.log(`${"─".repeat(repo.length)}`);
    for (const rec of recs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const parts: string[] = [];
      if (rec.prNumber) parts.push(`PR #${rec.prNumber}`);
      if (rec.branch) parts.push(`branch ${rec.branch}`);
      if (rec.headSha) parts.push(`sha ${rec.headSha.slice(0, 7)}`);
      const label = parts.length > 0 ? parts.join(", ") : "(no branch/PR)";
      console.log(`  ${label}`);
      console.log(`    session: ${rec.sessionID}`);
      console.log(`    updated: ${rec.updatedAt}`);
    }
  }
}