import { Result, TaggedError } from "better-result";

import { StorageError } from "./port";
import type { StorageDriver, StorageObjectStat } from "./port";

/**
 * The staging→finalize upload protocol (extracted from the presigned-upload
 * flow): the client uploads to a staging key, then the server verifies
 * size + SHA-256 against what was authorized, runs the scanner the driver
 * declares, and only then copies the object to its durable key and deletes
 * the staging object. Bytes never become "real" without verification.
 */

export type FinalizeRejection =
  | "missing-staging-object"
  | "size-mismatch"
  | "checksum-mismatch"
  | "scan-rejected";

export class FinalizeError extends TaggedError("FinalizeError")<{
  message: string;
  stagingKey: string;
  reason: FinalizeRejection | "io";
  cause?: unknown;
}>() {}

export type ScanVerdict =
  | { verdict: "clean" }
  | { verdict: "rejected"; threat: string };

export type Scanner = (bytes: Uint8Array) => Promise<ScanVerdict>;

export type FinalizeUploadOptions = {
  driver: StorageDriver;
  stagingKey: string;
  durableKey: string;
  expected: {
    size: number;
    /** Lowercase hex SHA-256 the upload was authorized with. */
    sha256: string;
  };
  /**
   * Required when the driver declares `scan: "inline"` or `"service"`;
   * ignored (skipped, by declaration) for `scan: "none"`.
   */
  scanner?: Scanner | undefined;
};

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  let out = "";
  for (const byte of digest) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
};

export const finalizeUpload = async ({
  driver,
  stagingKey,
  durableKey,
  expected,
  scanner,
}: FinalizeUploadOptions): Promise<Result<StorageObjectStat, FinalizeError>> => {
  const stat = await driver.head(stagingKey);
  if (stat.isErr()) {
    return Result.err(
      new FinalizeError({
        message: "Staged upload not found",
        stagingKey,
        reason: "missing-staging-object",
        cause: stat.error,
      }),
    );
  }
  if (stat.value.size !== expected.size) {
    return Result.err(
      new FinalizeError({
        message: `Staged upload is ${stat.value.size} bytes; ${expected.size} were authorized`,
        stagingKey,
        reason: "size-mismatch",
      }),
    );
  }

  const bytes = await driver.get(stagingKey);
  if (bytes.isErr()) {
    return Result.err(
      new FinalizeError({
        message: "Could not read staged upload",
        stagingKey,
        reason: "io",
        cause: bytes.error,
      }),
    );
  }

  const digest = await sha256Hex(bytes.value);
  if (digest !== expected.sha256.toLowerCase()) {
    return Result.err(
      new FinalizeError({
        message: "Staged upload checksum does not match the authorized SHA-256",
        stagingKey,
        reason: "checksum-mismatch",
      }),
    );
  }

  if (driver.scan !== "none") {
    if (!scanner) {
      return Result.err(
        new FinalizeError({
          message: `Driver declares scan capability "${driver.scan}" but no scanner was provided`,
          stagingKey,
          reason: "io",
        }),
      );
    }
    const verdict = await scanner(bytes.value);
    if (verdict.verdict === "rejected") {
      return Result.err(
        new FinalizeError({
          message: `Upload rejected by scanner: ${verdict.threat}`,
          stagingKey,
          reason: "scan-rejected",
        }),
      );
    }
  }

  const copied = await driver.copy(stagingKey, durableKey);
  if (copied.isErr()) {
    return Result.err(
      new FinalizeError({
        message: "Could not promote staged upload to its durable key",
        stagingKey,
        reason: "io",
        cause: copied.error,
      }),
    );
  }
  // Best-effort cleanup: a leftover staging object is garbage, not a hazard.
  await driver.delete(stagingKey);

  const durable = await driver.head(durableKey);
  if (durable.isErr()) {
    return Result.err(
      new FinalizeError({
        message: "Durable object missing after copy",
        stagingKey,
        reason: "io",
        cause: durable.error,
      }),
    );
  }
  return Result.ok(durable.value);
};

// Re-exported here so protocol consumers see one import surface.
export { StorageError };
