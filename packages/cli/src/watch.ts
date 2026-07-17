import { WebSocketClient } from "@opencode-observer/daemon";
import { loadToken, loadConfig } from "@opencode-observer/daemon/config";

export async function watchCommand(args: string[]): Promise<void> {
  const repo = args[0];
  if (!repo) {
    console.log("Usage: opencode-observer watch <owner/repo>");
    process.exit(1);
  }

  const token = await loadToken();
  if (!token) {
    console.error("Not authenticated. Run 'opencode-observer auth' first.");
    process.exit(1);
  }

  const config = await loadConfig();
  const client = new WebSocketClient(
    config.serverUrl,
    token,
    config.reconnectIntervalMs,
    config.maxReconnectIntervalMs,
    config.keepaliveIntervalMs,
  );

  client.on("connected", () => {
    console.log(`Connected, subscribing to ${repo}`);
    client.subscribe([repo]);
  });
  client.on("event", (msg: { event: { type: string; repoFullName: string; prNumber: number; message: string } }) => {
    const e = msg.event;
    console.log(`[${e.type}] ${e.repoFullName}#${e.prNumber}: ${e.message}`);
  });
  client.on("error", (message: string) => {
    console.error("Error:", message);
  });
  client.on("disconnected", () => {
    console.log("Disconnected");
  });

  console.log(`Watching ${repo} for events... (Ctrl+C to stop)`);
  client.connect();

  process.on("SIGINT", () => {
    client.disconnect();
    process.exit(0);
  });
}
