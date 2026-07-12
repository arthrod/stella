import { Result, TaggedError } from "better-result";

/**
 * Webhook verification discipline (reconciliation plan R6), generalized
 * from the DocuSign-Connect/Jira handling: timing-safe HMAC compare plus a
 * replay window on a signed timestamp. WebCrypto only — runs identically on
 * Bun and Workers.
 */

export type WebhookRejectionReason =
  | "malformed"
  | "signature-mismatch"
  | "replay-window-exceeded";

export class WebhookVerificationError extends TaggedError(
  "WebhookVerificationError",
)<{
  message: string;
  reason: WebhookRejectionReason;
}>() {}

/**
 * Constant-time comparison. Always scans the full length of the longer
 * input so mismatch position and length differences do not leak timing.
 */
export const timingSafeEqualText = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  const length = Math.max(bytesA.length, bytesB.length);
  let diff = bytesA.length ^ bytesB.length;
  for (let i = 0; i < length; i++) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0);
  }
  return diff === 0;
};

export type HmacEncoding = "hex" | "base64";

export type ComputeHmacOptions = {
  secret: string;
  /** The exact signed content (provider-specific: body, or `${timestamp}.${body}`). */
  content: string;
  encoding?: HmacEncoding | undefined;
};

const toHexString = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
};

const toBase64String = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export const computeHmacSignature = async ({
  secret,
  content,
  encoding = "hex",
}: ComputeHmacOptions): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(content)),
  );
  return encoding === "hex" ? toHexString(signature) : toBase64String(signature);
};

export type VerifyWebhookOptions = {
  secret: string;
  /** Raw payload body exactly as received. */
  payload: string;
  /** Signature presented by the caller. */
  signature: string;
  encoding?: HmacEncoding | undefined;
  /**
   * Provider timestamp (ms since epoch) when the scheme signs one. When
   * set, the signed content is `${timestamp}.${payload}` and the replay
   * window is enforced; when absent, the payload alone is signed and no
   * replay check runs (some providers, e.g. DocuSign Connect, sign only
   * the body).
   */
  timestampMs?: number | undefined;
  /** Maximum accepted age for a signed timestamp. Default: 5 minutes. */
  replayWindowMs?: number | undefined;
  /** Injectable clock for deterministic tests. */
  now?: (() => number) | undefined;
};

export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Verify a webhook: replay window first (cheap), then timing-safe HMAC
 * compare. The raw payload must be handed over byte-exact — re-serialized
 * JSON breaks signatures, which is why this takes `string`, not an object.
 */
export const verifyWebhookSignature = async (
  options: VerifyWebhookOptions,
): Promise<Result<void, WebhookVerificationError>> => {
  const { payload, signature, secret, timestampMs } = options;

  if (signature.length === 0 || secret.length === 0) {
    return Result.err(
      new WebhookVerificationError({
        message: "Missing signature or verification secret",
        reason: "malformed",
      }),
    );
  }

  let content = payload;
  if (timestampMs !== undefined) {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      return Result.err(
        new WebhookVerificationError({
          message: "Malformed webhook timestamp",
          reason: "malformed",
        }),
      );
    }
    const now = options.now ?? Date.now;
    const windowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    if (Math.abs(now() - timestampMs) > windowMs) {
      return Result.err(
        new WebhookVerificationError({
          message: "Webhook timestamp outside the replay window",
          reason: "replay-window-exceeded",
        }),
      );
    }
    content = `${timestampMs}.${payload}`;
  }

  const expected = await computeHmacSignature({
    secret,
    content,
    encoding: options.encoding,
  });
  if (!timingSafeEqualText(expected, signature)) {
    return Result.err(
      new WebhookVerificationError({
        message: "Webhook signature mismatch",
        reason: "signature-mismatch",
      }),
    );
  }

  return Result.ok(undefined);
};
