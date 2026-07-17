#!/usr/bin/env node

import { Daemon } from "./daemon.js";

const daemon = new Daemon();
daemon.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
