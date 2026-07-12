/**
 * The observability contract (reconciliation plan R7): wide events as the
 * shared logging vocabulary, carried with the PII-redaction discipline —
 * services log domain events through this interface; drains (PostHog,
 * Logfire, console, a file) are product drivers.
 *
 * The two hard rules the contract encodes:
 *  1. Errors leave the process as `errorTag` + `errorFingerprint`, never as
 *     raw messages (messages routinely embed emails, file names, SQL).
 *  2. Wide-event fields cross the redaction boundary by allowlist, not by
 *     blocklist — a field nobody declared safe is redacted by default.
 */

export type WideEventFields = Record<string, unknown>;

export type LogLevel = "info" | "warn" | "error";

/** The drain a product wires: receives fully redacted, structured events. */
export type LogDrain = (
  level: LogLevel,
  message: string,
  fields: WideEventFields,
) => void;

export interface PlatformLogger {
  /** Accumulate fields onto the current request's wide event (evlog-style). */
  set(fields: WideEventFields): void;
  info(message: string, fields?: WideEventFields): void;
  warn(message: string, fields?: WideEventFields): void;
  error(error: Error | string, fields?: WideEventFields): void;
}

/**
 * Stable, PII-free fingerprint for grouping errors: FNV-1a over the tag
 * and error name only — deliberately NOT over the message.
 */
export const errorFingerprint = (error: {
  name?: string;
  _tag?: string;
}): string => {
  const input = `${error._tag ?? ""}:${error.name ?? ""}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** The only error-derived fields allowed to leave the process. */
export const safeErrorFields = (
  error: Error | (Error & { _tag?: string }) | string,
): WideEventFields => {
  if (typeof error === "string") {
    return { errorTag: "UntaggedError", errorFingerprint: errorFingerprint({ name: error ? "string" : "" }) };
  }
  const tag = (error as { _tag?: string })._tag ?? "UntaggedError";
  return {
    errorTag: tag,
    errorFingerprint: errorFingerprint({ _tag: tag, name: error.name }),
  };
};

/**
 * Allowlist redaction: keys not explicitly declared safe are replaced with
 * "[redacted]" (value shape preserved as a string marker, never the value).
 */
export const redactFields = (
  fields: WideEventFields,
  allowedKeys: readonly string[],
): WideEventFields => {
  const allowed = new Set(allowedKeys);
  const out: WideEventFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = allowed.has(key) ? value : "[redacted]";
  }
  return out;
};

export type CreateLoggerOptions = {
  drain: LogDrain;
  /** Keys that may cross the boundary unredacted. */
  allowedKeys: readonly string[];
  /** Fields stamped on every event (service name, version, requestId…). */
  base?: WideEventFields | undefined;
};

export const createLogger = (options: CreateLoggerOptions): PlatformLogger => {
  const accumulated: WideEventFields = {};

  const emit = (
    level: LogLevel,
    message: string,
    fields: WideEventFields = {},
  ) => {
    const merged = { ...options.base, ...accumulated, ...fields };
    options.drain(level, message, redactFields(merged, options.allowedKeys));
  };

  return {
    set(fields) {
      Object.assign(accumulated, fields);
    },
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error(error, fields) {
      const errorFields = safeErrorFields(error);
      const message =
        typeof error === "string"
          ? "error"
          : `error: ${(error as { _tag?: string })._tag ?? error.name}`;
      emit("error", message, { ...fields, ...errorFields });
    },
  };
};

/** Test drain: captures every emitted event. */
export const createMemoryDrain = () => {
  const events: { level: LogLevel; message: string; fields: WideEventFields }[] =
    [];
  const drain: LogDrain = (level, message, fields) => {
    events.push({ level, message, fields });
  };
  return { drain, events };
};
