import type { DeviceFlowResponse, TokenResponse } from "@opencode-observer/shared";
import { saveToken, loadConfig } from "@opencode-observer/daemon/config";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export async function authCommand(): Promise<void> {
  const config = await loadConfig();
  const clientId = config.githubClientId;

  if (!clientId) {
    console.error("Error: GitHub Client ID not configured.");
    console.error("Run: opencode-observer config set githubClientId <your-client-id>");
    process.exit(1);
  }

  console.log("Initiating GitHub OAuth device flow...");

  const deviceRes = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "repo" }),
  });

  if (!deviceRes.ok) {
    console.error(`Failed to initiate device flow: ${deviceRes.status}`);
    process.exit(1);
  }

  const device = (await deviceRes.json()) as DeviceFlowResponse;

  console.log("");
  console.log(`  Open: ${device.verification_uri}`);
  console.log(`  Code: ${device.user_code}`);
  console.log("");
  console.log("Waiting for authorization...");

  const expiresAt = Date.now() + device.expires_in * 1000;
  const interval = (device.interval || 5) * 1000;

  while (Date.now() < expiresAt) {
    await sleep(interval);

    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const token = (await tokenRes.json()) as TokenResponse;

    if ("error" in token) {
      if (token.error === "authorization_pending") continue;
      if (token.error === "slow_down") {
        await sleep(5000);
        continue;
      }
      console.error(`Auth error: ${token.error} - ${token.error_description ?? ""}`);
      process.exit(1);
    }

    await saveToken(token.access_token);
    console.log("Authenticated successfully!");
    return;
  }

  console.error("Device code expired. Please try again.");
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
