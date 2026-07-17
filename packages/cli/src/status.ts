import { getDaemonStatus } from "@opencode-observer/daemon/service";
import { loadToken } from "@opencode-observer/daemon/config";

export async function statusCommand(): Promise<void> {
  const daemonStatus = await getDaemonStatus();
  const token = await loadToken();

  console.log("OpenCode GitHub Observer");
  console.log("========================");
  console.log(`Daemon:     ${daemonStatus.running ? `running (PID ${daemonStatus.pid})` : "stopped"}`);
  console.log(`Auth:       ${token ? "authenticated" : "not authenticated"}`);
  console.log(`Platform:   ${daemonStatus.platform}`);
}
