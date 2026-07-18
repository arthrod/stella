import { describe, expect, test } from "bun:test";

import {
  createLogger,
  createMemoryDrain,
  errorFingerprint,
  redactFields,
  safeErrorFields,
} from "./index";

class FakeTaggedError extends Error {
  readonly _tag = "StaleVersionError";
  constructor(message: string) {
    super(message);
    this.name = "StaleVersionError";
  }
}

describe("redactFields", () => {
  test("allowlist: undeclared keys are redacted, declared pass through", () => {
    const redacted = redactFields(
      { requestId: "req_1", email: "user@firm.example", durationMs: 12 },
      ["requestId", "durationMs"],
    );
    expect(redacted).toEqual({
      requestId: "req_1",
      email: "[redacted]",
      durationMs: 12,
    });
  });
});

describe("safeErrorFields / errorFingerprint", () => {
  test("never includes the message; fingerprint is stable per tag", () => {
    const a = safeErrorFields(new FakeTaggedError("secret: /home/user/contract.docx"));
    const b = safeErrorFields(new FakeTaggedError("different secret entirely"));
    expect(a["errorTag"]).toBe("StaleVersionError");
    expect(a["errorFingerprint"]).toBe(b["errorFingerprint"]);
    expect(JSON.stringify(a)).not.toContain("contract.docx");
  });

  test("different tags fingerprint differently", () => {
    expect(errorFingerprint({ _tag: "StaleVersionError", name: "E" })).not.toBe(
      errorFingerprint({ _tag: "NotFoundError", name: "E" }),
    );
  });
});

describe("createLogger", () => {
  test("wide event accumulation: set() fields ride every later emission", () => {
    const { drain, events } = createMemoryDrain();
    const log = createLogger({
      drain,
      allowedKeys: ["requestId", "organizationId", "stage"],
      base: { requestId: "req_1" },
    });

    log.set({ organizationId: "org_1" });
    log.info("stage advanced", { stage: "review" });

    expect(events.length).toBe(1);
    expect(events[0]?.fields).toEqual({
      requestId: "req_1",
      organizationId: "org_1",
      stage: "review",
    });
  });

  test("error emission carries only tag + fingerprint, and redaction still applies", () => {
    const { drain, events } = createMemoryDrain();
    const log = createLogger({
      drain,
      allowedKeys: ["errorTag", "errorFingerprint", "workflowId"],
    });

    log.error(new FakeTaggedError("SELECT * FROM users WHERE email='a@b.c'"), {
      workflowId: "wf_1",
      rawQuery: "SELECT * FROM users",
    });

    expect(events.length).toBe(1);
    const fields = events[0]?.fields ?? {};
    expect(fields["errorTag"]).toBe("StaleVersionError");
    expect(typeof fields["errorFingerprint"]).toBe("string");
    expect(fields["workflowId"]).toBe("wf_1");
    expect(fields["rawQuery"]).toBe("[redacted]");
    expect(JSON.stringify(events)).not.toContain("a@b.c");
  });
});
