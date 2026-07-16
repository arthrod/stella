import { Result } from "better-result";

import { StorageError } from "./port";
import type { PutOptions, ScanCapability, StorageDriver } from "./port";

/**
 * In-memory reference driver: the conformance target and test double.
 * `allowedPrefix` enforces key scoping the way a production driver scopes a
 * tenant to its prefix (e.g. `org-slug/…`) — operations outside the prefix
 * fail closed with `forbidden-key`.
 */
export type MemoryStorageOptions = {
  scan?: ScanCapability;
  allowedPrefix?: string;
};

type StoredObject = {
  bytes: Uint8Array;
  contentType?: string | undefined;
};

export type MemoryStorage = StorageDriver & {
  /** Test hook: direct object map access. */
  objects: Map<string, StoredObject>;
};

export const createMemoryStorage = (
  options: MemoryStorageOptions = {},
): MemoryStorage => {
  const objects = new Map<string, StoredObject>();
  const scan = options.scan ?? "inline";

  const guard = (key: string): StorageError | null => {
    if (options.allowedPrefix && !key.startsWith(options.allowedPrefix)) {
      return new StorageError({
        message: `Key outside this store's prefix ("${options.allowedPrefix}")`,
        key,
        reason: "forbidden-key",
      });
    }
    return null;
  };

  return {
    scan,
    objects,

    put(key: string, bytes: Uint8Array, putOptions?: PutOptions) {
      const denied = guard(key);
      if (denied) return Promise.resolve(Result.err(denied));
      if (putOptions?.ifNoneMatch === "*" && objects.has(key)) {
        return Promise.resolve(
          Result.err(
            new StorageError({
              message: "Object already exists",
              key,
              reason: "already-exists",
            }),
          ),
        );
      }
      objects.set(key, {
        bytes: bytes.slice(),
        contentType: putOptions?.contentType,
      });
      return Promise.resolve(Result.ok(undefined));
    },

    get(key: string) {
      const denied = guard(key);
      if (denied) return Promise.resolve(Result.err(denied));
      const stored = objects.get(key);
      if (!stored) {
        return Promise.resolve(
          Result.err(
            new StorageError({ message: "Not found", key, reason: "not-found" }),
          ),
        );
      }
      return Promise.resolve(Result.ok(stored.bytes.slice()));
    },

    head(key: string) {
      const denied = guard(key);
      if (denied) return Promise.resolve(Result.err(denied));
      const stored = objects.get(key);
      if (!stored) {
        return Promise.resolve(
          Result.err(
            new StorageError({ message: "Not found", key, reason: "not-found" }),
          ),
        );
      }
      return Promise.resolve(
        Result.ok({
          key,
          size: stored.bytes.byteLength,
          contentType: stored.contentType,
        }),
      );
    },

    copy(fromKey: string, toKey: string) {
      const denied = guard(fromKey) ?? guard(toKey);
      if (denied) return Promise.resolve(Result.err(denied));
      const stored = objects.get(fromKey);
      if (!stored) {
        return Promise.resolve(
          Result.err(
            new StorageError({
              message: "Not found",
              key: fromKey,
              reason: "not-found",
            }),
          ),
        );
      }
      objects.set(toKey, {
        bytes: stored.bytes.slice(),
        contentType: stored.contentType,
      });
      return Promise.resolve(Result.ok(undefined));
    },

    delete(key: string) {
      const denied = guard(key);
      if (denied) return Promise.resolve(Result.err(denied));
      objects.delete(key);
      return Promise.resolve(Result.ok(undefined));
    },
  };
};
