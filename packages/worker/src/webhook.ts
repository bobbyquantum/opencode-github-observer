export async function verifyGitHubSignature(
  payload: string | ArrayBuffer,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;

  const signatures = signatureHeader.split(",").reduce(
    (acc, part) => {
      const [key, value] = part.trim().split("=");
      if (key && value) acc[key] = value;
      return acc;
    },
    {} as Record<string, string>,
  );

  const sig256 = signatures["sha256"];
  if (!sig256) return false;

  const payloadBytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, payloadBytes);
  const expected = toHex(new Uint8Array(sig));

  return timingSafeEqual(expected, sig256);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
