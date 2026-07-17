import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:8787",
  },
  webServer: {
    // DEV_MODE lets the WebSocket hub accept any auth token as a dev user so the
    // full flow can be exercised without real GitHub credentials. The webhook
    // secret is injected so signature validation is enforced end-to-end.
    command:
      "npx wrangler dev --local --port 8787 --var DEV_MODE:true --var GITHUB_WEBHOOK_SECRET:test-webhook-secret",
    cwd: "packages/worker",
    port: 8787,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
