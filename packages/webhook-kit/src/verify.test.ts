import { describe, expect, test } from "bun:test";

import {
  computeHmacSignature,
  timingSafeEqualText,
  verifyWebhookSignature,
} from "./verify";

const SECRET = "whsec_test_secret";
const PAYLOAD = JSON.stringify({ event: "envelope-completed", envelopeId: "env_1" });
const NOW = 1_770_000_000_000;

describe("timingSafeEqualText", () => {
  test("equal, unequal, and different-length inputs", () => {
    expect(timingSafeEqualText("abc", "abc")).toBe(true);
    expect(timingSafeEqualText("abc", "abd")).toBe(false);
    expect(timingSafeEqualText("abc", "abcd")).toBe(false);
    expect(timingSafeEqualText("", "")).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  test("accepts a valid body-only signature (DocuSign Connect style)", async () => {
    const signature = await computeHmacSignature({ secret: SECRET, content: PAYLOAD });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature,
    });
    expect(result.isOk()).toBe(true);
  });

  test("accepts a valid timestamped signature within the replay window", async () => {
    const signature = await computeHmacSignature({
      secret: SECRET,
      content: `${NOW}.${PAYLOAD}`,
    });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature,
      timestampMs: NOW,
      now: () => NOW + 60_000, // one minute later
    });
    expect(result.isOk()).toBe(true);
  });

  test("rejects a tampered payload", async () => {
    const signature = await computeHmacSignature({ secret: SECRET, content: PAYLOAD });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD.replace("env_1", "env_2"),
      signature,
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.reason).toBe("signature-mismatch");
  });

  test("rejects a signature minted with the wrong secret", async () => {
    const signature = await computeHmacSignature({
      secret: "attacker-secret",
      content: PAYLOAD,
    });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature,
    });
    expect(result.isErr()).toBe(true);
  });

  test("rejects a replayed (stale) timestamp even with a valid signature", async () => {
    const staleTs = NOW - 6 * 60 * 1000; // six minutes old, window is five
    const signature = await computeHmacSignature({
      secret: SECRET,
      content: `${staleTs}.${PAYLOAD}`,
    });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature,
      timestampMs: staleTs,
      now: () => NOW,
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.reason).toBe("replay-window-exceeded");
  });

  test("rejects future-dated timestamps outside the window (clock-skew attack)", async () => {
    const futureTs = NOW + 10 * 60 * 1000;
    const signature = await computeHmacSignature({
      secret: SECRET,
      content: `${futureTs}.${PAYLOAD}`,
    });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature,
      timestampMs: futureTs,
      now: () => NOW,
    });
    expect(result.isErr()).toBe(true);
  });

  test("rejects empty signature and malformed timestamps as malformed", async () => {
    const missing = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature: "",
    });
    expect(missing.isErr()).toBe(true);
    if (!missing.isErr()) throw new Error("expected err");
    expect(missing.error.reason).toBe("malformed");

    const badTs = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature: "deadbeef",
      timestampMs: Number.NaN,
    });
    expect(badTs.isErr()).toBe(true);
    if (!badTs.isErr()) throw new Error("expected err");
    expect(badTs.error.reason).toBe("malformed");
  });

  test("base64 encoding round-trips too", async () => {
    const signature = await computeHmacSignature({
      secret: SECRET,
      content: PAYLOAD,
      encoding: "base64",
    });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      signature,
      encoding: "base64",
    });
    expect(result.isOk()).toBe(true);
  });
});
