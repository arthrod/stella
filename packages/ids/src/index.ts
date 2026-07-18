/**
 * Kernel id primitives (reconciliation plan R2/§10): the branded-id
 * mechanism and a runtime-neutral UUIDv7 mint. Products keep their own
 * brand vocabularies (`SafeId<"matter">`, `wf_…` prefixes); the kernel owns
 * the mechanism so engines and drivers mint compatible, time-sortable ids
 * on any runtime.
 *
 * WinterTC-portable by construction: WebCrypto `getRandomValues` only — no
 * `Bun.randomUUIDv7`, no `node:crypto`. Product edges may keep their
 * runtime-native minting (Bun's is fine app-side); shared code uses this.
 */

declare const __brand: unique symbol;

/** Nominal string brand: `BrandedId<"workflow">` ≠ `BrandedId<"user">`. */
export type BrandedId<TBrand extends string> = string & {
  readonly [__brand]: TBrand;
};

// SAFETY: the brand is phantom-only; runtime validation happens at call sites.
export const toBrandedId = <TBrand extends string>(
  value: string,
): BrandedId<TBrand> => value as BrandedId<TBrand>;

export type Uuidv7Options = {
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: (() => number) | undefined;
  /** Injectable randomness for deterministic tests. */
  fillRandom?: ((bytes: Uint8Array) => void) | undefined;
};

const HEX = "0123456789abcdef";

const toHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out;
};

/**
 * RFC 9562 UUIDv7: 48-bit unix-ms timestamp, version nibble 7, 74 random
 * bits. Time-ordered, so ids sort lexicographically by creation time —
 * the property both products' schemas rely on for index locality.
 */
export const uuidv7 = (options: Uuidv7Options = {}): string => {
  const now = options.now ?? Date.now;
  const fillRandom =
    options.fillRandom ?? ((bytes: Uint8Array) => crypto.getRandomValues(bytes));

  const bytes = new Uint8Array(16);
  fillRandom(bytes);

  const timestamp = now();
  // 48-bit big-endian timestamp in bytes 0..5.
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  // Version 7 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Mint a branded UUIDv7. */
export const mintBrandedId = <TBrand extends string>(
  options?: Uuidv7Options,
): BrandedId<TBrand> => toBrandedId<TBrand>(uuidv7(options));

/**
 * Prefixed id in the `wf_<uuid>` style (log-readable table-scoped ids).
 * The uuid defaults to a fresh v7 so prefixed ids stay time-sortable
 * within a prefix.
 */
export const prefixedId = (prefix: string, uuid: string = uuidv7()): string =>
  `${prefix}_${uuid}`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const isUuid = (value: string): boolean =>
  UUID_PATTERN.test(value.toLowerCase());
