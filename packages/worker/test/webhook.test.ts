import { describe, it, expect } from "vitest";
import { verifyGitHubSignature } from "../src/webhook.js";

describe("verifyGitHubSignature", () => {
  it("validates correct HMAC-SHA256 signature", async () => {
    const payload = '{"action":"completed"}';
    const secret = "test-secret";

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );

    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const signature = `sha256=${hex}`;
    const valid = await verifyGitHubSignature(payload, signature, secret);
    expect(valid).toBe(true);
  });

  it("rejects incorrect signature", async () => {
    const payload = '{"action":"completed"}';
    const secret = "test-secret";
    const signature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";

    const valid = await verifyGitHubSignature(payload, signature, secret);
    expect(valid).toBe(false);
  });

  it("rejects empty signature", async () => {
    const valid = await verifyGitHubSignature("payload", "", "secret");
    expect(valid).toBe(false);
  });

  it("rejects signature with wrong prefix", async () => {
    const valid = await verifyGitHubSignature("payload", "sha1=abc123", "secret");
    expect(valid).toBe(false);
  });

  it("rejects signature with different length", async () => {
    const valid = await verifyGitHubSignature("payload", "sha256=abc", "secret");
    expect(valid).toBe(false);
  });
});
