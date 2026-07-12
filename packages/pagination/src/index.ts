/**
 * The `Page<T>` cursor-pagination envelope (kernel convention per the
 * reconciliation plan R2): `{ items, nextCursor, limit }`, opaque
 * base64url-encoded cursor parts, and the cursor-part validators list
 * endpoints share. Extracted from the API's `lib/pagination.ts`; the
 * encoding is byte-compatible with the original `Buffer`-based
 * implementation (base64url alphabet, no padding), so cursors already in
 * client hands keep working.
 *
 * Runtime-neutral: `TextEncoder`/`TextDecoder` + `btoa`/`atob` only.
 */

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  limit: number;
};

type CursorPrimitive = string | number | boolean | null;

type CursorPageOptions<T> = {
  rows: readonly T[];
  limit: number;
  cursorForItem: (item: T) => string;
};

const dateOnlyCursorPartPattern = /^\d{4}-\d{2}-\d{2}$/u;
const uuidCursorPartPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export const createCursorPage = <T>({
  rows,
  limit,
  cursorForItem,
}: CursorPageOptions<T>): Page<T> => {
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);

  return {
    items,
    limit,
    nextCursor:
      rows.length > limit && lastItem !== undefined
        ? cursorForItem(lastItem)
        : null,
  };
};

const base64UrlEncodeText = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const base64UrlDecodeText = (value: string): string | null => {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

export const encodePaginationCursor = (
  parts: readonly CursorPrimitive[],
): string => base64UrlEncodeText(JSON.stringify(parts));

export const decodePaginationCursor = (cursor: string): unknown[] | null => {
  const text = base64UrlDecodeText(cursor);
  if (text === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const isDateOnlyPaginationCursorPart = (
  value: unknown,
): value is string => {
  if (typeof value !== "string" || !dateOnlyCursorPartPattern.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

export const isUuidPaginationCursorPart = (value: unknown): value is string =>
  typeof value === "string" && uuidCursorPartPattern.test(value);

export const parseDateTimePaginationCursorPart = (
  value: unknown,
): Date | null => {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return null;
  }

  return parsed;
};
