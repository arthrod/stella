import { describe, expect, test } from "bun:test";

import { createMemoryStorage } from "./driver-memory";
import { putIfAbsent } from "./port";
import { finalizeUpload, sha256Hex } from "./protocol";

const BYTES = new TextEncoder().encode("signed contract bytes");

const stage = async (driver: ReturnType<typeof createMemoryStorage>) => {
  const put = await driver.put("tmp/upl_1", BYTES, {
    contentType: "application/pdf",
  });
  if (put.isErr()) throw put.error;
  return { size: BYTES.byteLength, sha256: await sha256Hex(BYTES) };
};

describe("staging→finalize", () => {
  test("happy path: verified bytes are promoted; staging is cleaned up", async () => {
    const driver = createMemoryStorage();
    const expected = await stage(driver);

    const result = await finalizeUpload({
      driver,
      stagingKey: "tmp/upl_1",
      durableKey: "docs/doc_1.pdf",
      expected,
      scanner: () => Promise.resolve({ verdict: "clean" }),
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw result.error;
    expect(result.value.key).toBe("docs/doc_1.pdf");
    expect(result.value.size).toBe(BYTES.byteLength);
    expect(driver.objects.has("tmp/upl_1")).toBe(false);
    expect(driver.objects.has("docs/doc_1.pdf")).toBe(true);
  });

  test("size mismatch is rejected before any bytes are promoted", async () => {
    const driver = createMemoryStorage();
    const expected = await stage(driver);

    const result = await finalizeUpload({
      driver,
      stagingKey: "tmp/upl_1",
      durableKey: "docs/doc_1.pdf",
      expected: { ...expected, size: expected.size + 1 },
      scanner: () => Promise.resolve({ verdict: "clean" }),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.reason).toBe("size-mismatch");
    expect(driver.objects.has("docs/doc_1.pdf")).toBe(false);
  });

  test("checksum mismatch is rejected (bytes differ from what was authorized)", async () => {
    const driver = createMemoryStorage();
    const expected = await stage(driver);

    const result = await finalizeUpload({
      driver,
      stagingKey: "tmp/upl_1",
      durableKey: "docs/doc_1.pdf",
      expected: { ...expected, sha256: "0".repeat(64) },
      scanner: () => Promise.resolve({ verdict: "clean" }),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.reason).toBe("checksum-mismatch");
    expect(driver.objects.has("docs/doc_1.pdf")).toBe(false);
  });

  test("scanner rejection blocks promotion", async () => {
    const driver = createMemoryStorage();
    const expected = await stage(driver);

    const result = await finalizeUpload({
      driver,
      stagingKey: "tmp/upl_1",
      durableKey: "docs/doc_1.pdf",
      expected,
      scanner: () => Promise.resolve({ verdict: "rejected", threat: "EICAR" }),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.reason).toBe("scan-rejected");
    expect(driver.objects.has("docs/doc_1.pdf")).toBe(false);
  });

  test("a scan-capable driver without a scanner fails closed", async () => {
    const driver = createMemoryStorage({ scan: "inline" });
    const expected = await stage(driver);

    const result = await finalizeUpload({
      driver,
      stagingKey: "tmp/upl_1",
      durableKey: "docs/doc_1.pdf",
      expected,
    });

    expect(result.isErr()).toBe(true);
    expect(driver.objects.has("docs/doc_1.pdf")).toBe(false);
  });

  test('scan "none" skips scanning by declaration (recorded risk, not silent)', async () => {
    const driver = createMemoryStorage({ scan: "none" });
    const expected = await stage(driver);

    const result = await finalizeUpload({
      driver,
      stagingKey: "tmp/upl_1",
      durableKey: "docs/doc_1.pdf",
      expected,
    });

    expect(result.isOk()).toBe(true);
  });

  test("missing staging object", async () => {
    const driver = createMemoryStorage();
    const result = await finalizeUpload({
      driver,
      stagingKey: "tmp/never-uploaded",
      durableKey: "docs/doc_1.pdf",
      expected: { size: 1, sha256: "0".repeat(64) },
      scanner: () => Promise.resolve({ verdict: "clean" }),
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.reason).toBe("missing-staging-object");
  });
});

describe("putIfAbsent (idempotent archival)", () => {
  test("first write creates; the retry is a no-op success; content survives", async () => {
    const driver = createMemoryStorage();

    const first = await putIfAbsent(driver, "archive/env_1.pdf", BYTES);
    expect(first.isOk()).toBe(true);
    if (!first.isOk()) throw first.error;
    expect(first.value).toBe("created");

    const retry = await putIfAbsent(
      driver,
      "archive/env_1.pdf",
      new TextEncoder().encode("DIFFERENT bytes from a replayed webhook"),
    );
    expect(retry.isOk()).toBe(true);
    if (!retry.isOk()) throw retry.error;
    expect(retry.value).toBe("already-exists");

    const stored = await driver.get("archive/env_1.pdf");
    if (stored.isErr()) throw stored.error;
    expect(new TextDecoder().decode(stored.value)).toBe("signed contract bytes");
  });
});

describe("prefix scoping", () => {
  test("operations outside the allowed prefix fail closed", async () => {
    const driver = createMemoryStorage({ allowedPrefix: "acme/" });

    const inside = await driver.put("acme/docs/a.pdf", BYTES);
    expect(inside.isOk()).toBe(true);

    const outside = await driver.put("globex/docs/a.pdf", BYTES);
    expect(outside.isErr()).toBe(true);
    if (!outside.isErr()) throw new Error("expected err");
    expect(outside.error.reason).toBe("forbidden-key");

    const read = await driver.get("globex/docs/a.pdf");
    expect(read.isErr()).toBe(true);
  });
});
