import { describe, test } from "bun:test";

import { createMemoryStorage, finalizeUpload, putIfAbsent } from "@stll/storage";

import { storageProtocolChecks } from "./storage-protocol";

// Reference proof: the kernel storage port + memory driver pass suite 4.
const driver = createMemoryStorage();
const scoped = createMemoryStorage({ allowedPrefix: "acme/" });

const checks = storageProtocolChecks({
  stage: async (key, bytes) => {
    const result = await driver.put(key, bytes);
    if (result.isErr()) throw result.error;
  },
  finalize: async ({ stagingKey, durableKey, expectedSize, expectedSha256 }) => {
    const result = await finalizeUpload({
      driver,
      stagingKey,
      durableKey,
      expected: { size: expectedSize, sha256: expectedSha256 },
      scanner: () => Promise.resolve({ verdict: "clean" }),
    });
    return result.isOk();
  },
  exists: async (key) => (await driver.head(key)).isOk(),
  read: async (key) => {
    const result = await driver.get(key);
    if (result.isErr()) throw result.error;
    return result.value;
  },
  putIfAbsent: async (key, bytes) => {
    const result = await putIfAbsent(driver, key, bytes);
    if (result.isErr()) throw result.error;
    return result.value;
  },
  forbiddenKey: "globex/leak.bin",
  writeForbidden: async (key, bytes) => (await scoped.put(key, bytes)).isOk(),
});

describe("conformance/storage-protocol on @stll/storage memory driver", () => {
  for (const check of checks) {
    test(check.name, check.run);
  }
});
