import { describe, expect, test } from "bun:test";

import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
} from "./index";

describe("cursor encoding", () => {
  test("round-trips primitive parts", () => {
    const parts = ["2026-07-11T00:00:00.000Z", "0198f9aa-0000-7000-8000-0000000000aa", 42, true, null];
    expect(decodePaginationCursor(encodePaginationCursor(parts))).toEqual(parts);
  });

  test("is byte-compatible with the Buffer base64url encoding it replaces", () => {
    const parts = ["héllo wörld ✓", "b"];
    const expected = Buffer.from(JSON.stringify(parts)).toString("base64url");
    expect(encodePaginationCursor(parts)).toBe(expected);
    // And decodes cursors minted by the old implementation.
    expect(decodePaginationCursor(expected)).toEqual(parts);
  });

  test("rejects garbage, non-array JSON, and truncated input with null", () => {
    expect(decodePaginationCursor("!!!not-base64!!!")).toBeNull();
    expect(
      decodePaginationCursor(Buffer.from('{"a":1}').toString("base64url")),
    ).toBeNull();
    expect(decodePaginationCursor("")).toBeNull();
  });
});

describe("createCursorPage", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("full page: trims to limit and points at the last returned item", () => {
    const page = createCursorPage({ rows, limit: 2, cursorForItem: (r) => r.id });
    expect(page.items).toEqual([{ id: "a" }, { id: "b" }]);
    expect(page.nextCursor).toBe("b");
    expect(page.limit).toBe(2);
  });

  test("final page: no next cursor when rows fit the limit", () => {
    const page = createCursorPage({ rows, limit: 3, cursorForItem: (r) => r.id });
    expect(page.items.length).toBe(3);
    expect(page.nextCursor).toBeNull();
  });

  test("empty result", () => {
    const page = createCursorPage({ rows: [], limit: 10, cursorForItem: () => "x" });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("cursor-part validators", () => {
  test("date-only parts", () => {
    expect(isDateOnlyPaginationCursorPart("2026-07-11")).toBe(true);
    expect(isDateOnlyPaginationCursorPart("2026-13-40")).toBe(false);
    expect(isDateOnlyPaginationCursorPart("2026-07-11T00:00:00Z")).toBe(false);
    expect(isDateOnlyPaginationCursorPart(20260711)).toBe(false);
  });

  test("uuid parts", () => {
    expect(isUuidPaginationCursorPart("0198f9aa-0000-7000-8000-0000000000aa")).toBe(true);
    expect(isUuidPaginationCursorPart("not-a-uuid")).toBe(false);
  });

  test("datetime parts require exact ISO round-trip", () => {
    const iso = "2026-07-11T12:34:56.789Z";
    expect(parseDateTimePaginationCursorPart(iso)?.toISOString()).toBe(iso);
    expect(parseDateTimePaginationCursorPart("2026-07-11")).toBeNull();
    expect(parseDateTimePaginationCursorPart(123)).toBeNull();
  });
});
