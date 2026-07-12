// The Page<T> envelope and cursor helpers moved to the platform kernel
// (`@stll/pagination`, ADR-0004 divergence freeze); this module keeps the
// app-local import path stable. The kernel encoding is byte-compatible with
// the previous Buffer-based implementation, so live cursors keep working.
export {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isDateOnlyPaginationCursorPart,
  isUuidPaginationCursorPart,
  parseDateTimePaginationCursorPart,
  type Page,
} from "@stll/pagination";
