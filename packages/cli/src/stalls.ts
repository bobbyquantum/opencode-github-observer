import { OpencodeClient } from "@opencode-observer/daemon";
import { detectStalls, buildDirectoryHints } from "@opencode-observer/daemon";
import type { StallConfig } from "@opencode-observer/daemon";
import { loadConfig } from "@opencode-observer/daemon/config";

export async function stallsCommand(args: string[]): Promise<void> {
  const config = await loadConfig();
  const repoNames = Object.keys(config.repos);

  if (repoNames.length === 0) {
    console.log("No repos configured. Use 'opencode-observer config set repos.owner/repo.workdir <path>' first.");
    return;
  }

  const dryRun = !args.includes("--abort");
  const stallConfig: StallConfig = {
    thresholdMs: 30 * 60 * 1000,
    directoryHints: buildDirectoryHints(config.repos),
    abort: !dryRun,
  };

  let found = 0;
  for (const [repo, repoConfig] of Object.entries(config.repos)) {
    try {
      const client = new OpencodeClient({
        baseUrl: repoConfig.serverUrl ?? "http://127.0.0.1:4096",
        ...(repoConfig.serverPassword ? { password: repoConfig.serverPassword } : {}),
      });
      await client.health();

      const result = await detectStalls(client, { ...stallConfig, abort: false });
      if (result.findings.length > 0) {
        found += result.findings.length;
        console.log(`\n${repo}`);
        console.log(`${"─".repeat(repo.length)}`);
        for (const finding of result.findings) {
          const longestMin = Math.round(Math.max(...finding.stalledTools.map((t) => t.runningForMs)) / 60000);
          console.log(`  ${finding.sessionTitle} (stalled ${longestMin}min)`);
          console.log(`    session: ${finding.sessionID}`);
          console.log(`    dir: ${finding.directory.split("/").pop()}`);
          for (const tool of finding.stalledTools) {
            const min = Math.round(tool.runningForMs / 60000);
            console.log(`    [${min}min] ${tool.tool}: ${tool.command.slice(0, 80)}`);
          }
        }
      }
    } catch (err) {
      console.error(`Could not check ${repo}: ${(err as Error).message}`);
    }
  }

  if (found === 0) {
    console.log("No stalled sessions detected.");
  } else {
    console.log(`\n${found} stalled session(s) found.`);
    if (dryRun) {
      console.log("Run 'opencode-observer stalls --abort' to abort them.");
    }
  }
}