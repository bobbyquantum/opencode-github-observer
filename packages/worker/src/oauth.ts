import type { DeviceFlowResponse, TokenResponse } from "@opencode-observer/shared";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

export async function initiateDeviceFlow(clientId: string, scope = "repo"): Promise<DeviceFlowResponse> {
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  if (!res.ok) throw new Error(`Device flow init failed: ${res.status}`);
  return (await res.json()) as DeviceFlowResponse;
}

export async function pollForToken(clientId: string, deviceCode: string): Promise<TokenResponse> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!res.ok) throw new Error(`Token poll failed: ${res.status}`);
  return (await res.json()) as TokenResponse;
}

export async function getGitHubUser(accessToken: string): Promise<{ id: number; login: string }> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-observer-worker",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`User fetch failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id: number; login: string };
  return { id: data.id, login: data.login };
}

export async function validateGitHubToken(token: string): Promise<{ id: number; login: string } | null> {
  try {
    return await getGitHubUser(token);
  } catch {
    return null;
  }
}
