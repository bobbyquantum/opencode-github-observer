#!/usr/bin/env node

import { authCommand } from "./auth.js";
import { daemonCommand } from "./daemon-cmd.js";
import { configCommand } from "./config-cmd.js";
import { watchCommand } from "./watch.js";
import { statusCommand } from "./status.js";
import { sessionsCommand } from "./sessions.js";
import { stallsCommand } from "./stalls.js";
import { subscribeCommand } from "./subscribe.js";

const USAGE = `
opencode-observer - Self-hosted GitHub webhook auto-fix daemon

Usage:
  opencode-observer auth                    Login with GitHub OAuth
  opencode-observer daemon start            Start the daemon
  opencode-observer daemon stop             Stop the daemon
  opencode-observer daemon status           Show daemon status
  opencode-observer daemon logs [-f]        View daemon logs
  opencode-observer daemon install          Install as system service
  opencode-observer daemon uninstall        Uninstall system service
  opencode-observer config get [key]        Show config
  opencode-observer config set <key> <val>  Set config value (dotted keys supported)
  opencode-observer subscribe --repo <owner/repo> --pr <n> [--branch <b>] [--session <id>]
                                            Subscribe current session to PR events
  opencode-observer watch <owner/repo>      Watch a repo for events (live)
  opencode-observer sessions                List detected PR ↔ opencode session mappings
  opencode-observer stalls [--abort]       Detect stalled sessions (add --abort to kill them)
  opencode-observer status                  Show overall status
  opencode-observer help                    Show this help
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "auth":
      await authCommand();
      break;
    case "daemon":
      await daemonCommand(args.slice(1));
      break;
    case "config":
      await configCommand(args.slice(1));
      break;
    case "watch":
      await watchCommand(args.slice(1));
      break;
    case "sessions":
      await sessionsCommand();
      break;
    case "stalls":
      await stallsCommand(args.slice(1));
      break;
    case "subscribe":
      await subscribeCommand(args.slice(1));
      break;
    case "status":
      await statusCommand();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});