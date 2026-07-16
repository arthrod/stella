import { Result, TaggedError } from "better-result";

/**
 * The object-storage port (reconciliation plan R5): "what a valid upload
 * is" (this port + the staging→finalize protocol) is separated from "where
 * bytes live" (a driver: S3-endpoint for AWS/MinIO/R2-over-S3, a Workers
 * R2-binding driver for the zero-egress hot path, memory for tests).
 *
 * Scanning is a declared capability, not an assumption: `"inline"` (the
 * runtime can run a scanner in-process), `"service"` (bytes are sent to a
 * scan service), or `"none"` (recorded risk — the finalize protocol then
 * skips the scan step instead of silently pretending it happened).
 */

export type ScanCapability = "inline" | "service" | "none";

export type StorageErrorReason =
  | "not-found"
  | "already-exists"
  | "forbidden-key"
  | "io";

export class StorageError extends TaggedError("StorageError")<{
  message: string;
  key?: string;
  reason: StorageErrorReason;
  cause?: unknown;
}>() {}

export type StorageObjectStat = {
  key: string;
  size: number;
  contentType?: string | undefined;
};

export type PutOptions = {
  contentType?: string | undefined;
  /**
   * `"*"` = create-only (HTTP If-None-Match: *): fail with
   * `already-exists` when the key is already present. The primitive behind
   * `putIfAbsent` idempotent archival.
   */
  ifNoneMatch?: "*" | undefined;
};

export interface StorageDriver {
  readonly scan: ScanCapability;
  put(
    key: string,
    bytes: Uint8Array,
    options?: PutOptions,
  ): Promise<Result<void, StorageError>>;
  get(key: string): Promise<Result<Uint8Array, StorageError>>;
  head(key: string): Promise<Result<StorageObjectStat, StorageError>>;
  copy(fromKey: string, toKey: string): Promise<Result<void, StorageError>>;
  delete(key: string): Promise<Result<void, StorageError>>;
}

export type PutIfAbsentOutcome = "created" | "already-exists";

/**
 * Idempotent archival: create the object unless it already exists, and
 * treat "already exists" as success (a retry or a double-fired webhook
 * must not fail or clobber the archived original).
 */
export const putIfAbsent = async (
  driver: StorageDriver,
  key: string,
  bytes: Uint8Array,
  options?: Omit<PutOptions, "ifNoneMatch">,
): Promise<Result<PutIfAbsentOutcome, StorageError>> => {
  const result = await driver.put(key, bytes, {
    ...options,
    ifNoneMatch: "*",
  });
  if (result.isOk()) {
    return Result.ok("created");
  }
  if (result.error.reason === "already-exists") {
    return Result.ok("already-exists");
  }
  return Result.err(result.error);
};
