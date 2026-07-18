import { describe, expect, test } from "bun:test";

import { isUuid, mintBrandedId, prefixedId, toBrandedId, uuidv7 } from "./index";

describe("uuidv7", () => {
  test("produces canonical RFC 9562 v7 uuids", () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv7();
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe("7"); // version nibble
      expect("89ab").toContain(id[19] ?? ""); // variant bits 10xx
    }
  });

  test("encodes the clock: later ids sort lexicographically after earlier ones", () => {
    let tick = 1_700_000_000_000;
    const earlier = uuidv7({ now: () => tick });
    tick += 5;
    const later = uuidv7({ now: () => tick });
    expect(earlier < later).toBe(true);
  });

  test("is deterministic under injected clock + randomness", () => {
    const fixed = {
      now: () => 1_700_000_000_000,
      fillRandom: (bytes: Uint8Array) => bytes.fill(0xab),
    };
    expect(uuidv7(fixed)).toBe(uuidv7(fixed));
  });

  test("distinct ids under real randomness", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });
});

describe("branded ids", () => {
  test("mintBrandedId returns a valid uuid carrying the phantom brand", () => {
    const id = mintBrandedId<"workflow">();
    expect(isUuid(id)).toBe(true);
    // Type-level: assignment to a different brand must not compile.
    // @ts-expect-error — workflow id is not a user id
    const _wrong: import("./index").BrandedId<"user"> = id;
    void _wrong;
  });

  test("toBrandedId brands without altering the value", () => {
    const branded: string = toBrandedId<"organization">("org_123");
    expect(branded).toBe("org_123");
  });
});

describe("prefixedId", () => {
  test("mints wf_<uuidv7> style ids", () => {
    const id = prefixedId("wf");
    expect(id.startsWith("wf_")).toBe(true);
    expect(isUuid(id.slice(3))).toBe(true);
  });

  test("accepts an explicit uuid", () => {
    expect(prefixedId("rec", "00000000-0000-7000-8000-000000000000")).toBe(
      "rec_00000000-0000-7000-8000-000000000000",
    );
  });
});
