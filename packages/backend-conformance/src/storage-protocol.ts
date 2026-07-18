import { violation } from "./checks";
import type { ConformanceCheck } from "./checks";

/**
 * Storage-protocol conformance (suite 4): staging→finalize verification,
 * `putIfAbsent` idempotency, and prefix scoping. The adapter wraps the
 * product's storage driver + finalize implementation; the suite owns the
 * scenarios.
 */
export type StorageProtocolAdapter = {
  /** Write bytes to a staging key. */
  stage(key: string, bytes: Uint8Array): Promise<void>;
  /**
   * Run the product's finalize: verify expected size/sha256, scan, promote
   * to the durable key. Resolve true when finalize accepted the upload.
   */
  finalize(args: {
    stagingKey: string;
    durableKey: string;
    expectedSize: number;
    expectedSha256: string;
  }): Promise<boolean>;
  /** Does an object exist at this key? */
  exists(key: string): Promise<boolean>;
  /** Read an object's bytes (throws/rejects when absent). */
  read(key: string): Promise<Uint8Array>;
  /** The product's idempotent-archival write. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<"created" | "already-exists">;
  /** A key OUTSIDE the store's allowed scope; omit to skip the scoping check. */
  forbiddenKey?: string;
  /** Attempt a write to `forbiddenKey`; resolve true when (wrongly) accepted. */
  writeForbidden?(key: string, bytes: Uint8Array): Promise<boolean>;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  let out = "";
  for (const byte of digest) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
};

const CONTENT = new TextEncoder().encode("conformance probe object");

export const storageProtocolChecks = (
  adapter: StorageProtocolAdapter,
): ConformanceCheck[] => {
  const checks: ConformanceCheck[] = [
    {
      name: "storage: verified staging→finalize promotes the object",
      run: async () => {
        await adapter.stage("tmp/conf_ok", CONTENT);
        const accepted = await adapter.finalize({
          stagingKey: "tmp/conf_ok",
          durableKey: "durable/conf_ok",
          expectedSize: CONTENT.byteLength,
          expectedSha256: await sha256Hex(CONTENT),
        });
        if (!accepted) violation("a verified upload was rejected");
        if (!(await adapter.exists("durable/conf_ok"))) {
          violation("finalize accepted but the durable object is missing");
        }
      },
    },
    {
      name: "storage: a size mismatch is rejected and nothing is promoted",
      run: async () => {
        await adapter.stage("tmp/conf_size", CONTENT);
        const accepted = await adapter.finalize({
          stagingKey: "tmp/conf_size",
          durableKey: "durable/conf_size",
          expectedSize: CONTENT.byteLength + 7,
          expectedSha256: await sha256Hex(CONTENT),
        });
        if (accepted) violation("size mismatch was accepted");
        if (await adapter.exists("durable/conf_size")) {
          violation("size-mismatched upload reached its durable key");
        }
      },
    },
    {
      name: "storage: a checksum mismatch is rejected and nothing is promoted",
      run: async () => {
        await adapter.stage("tmp/conf_sha", CONTENT);
        const accepted = await adapter.finalize({
          stagingKey: "tmp/conf_sha",
          durableKey: "durable/conf_sha",
          expectedSize: CONTENT.byteLength,
          expectedSha256: "0".repeat(64),
        });
        if (accepted) violation("checksum mismatch was accepted");
        if (await adapter.exists("durable/conf_sha")) {
          violation("checksum-mismatched upload reached its durable key");
        }
      },
    },
    {
      name: "storage: putIfAbsent is idempotent and never clobbers the original",
      run: async () => {
        const first = await adapter.putIfAbsent("durable/conf_archive", CONTENT);
        if (first !== "created") violation(`first write reported "${first}"`);
        const replayBytes = new TextEncoder().encode("replayed different bytes");
        const second = await adapter.putIfAbsent("durable/conf_archive", replayBytes);
        if (second !== "already-exists") {
          violation(`replay write reported "${second}"`);
        }
        const stored = await adapter.read("durable/conf_archive");
        if (new TextDecoder().decode(stored) !== "conformance probe object") {
          violation("replay write clobbered the archived original");
        }
      },
    },
  ];

  if (adapter.forbiddenKey && adapter.writeForbidden) {
    const forbiddenKey = adapter.forbiddenKey;
    const writeForbidden = adapter.writeForbidden.bind(adapter);
    checks.push({
      name: "storage: keys outside the store's scope fail closed",
      run: async () => {
        const accepted = await writeForbidden(forbiddenKey, CONTENT);
        if (accepted) violation("a write outside the allowed prefix succeeded");
      },
    });
  }

  return checks;
};
