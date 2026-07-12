import { describe, expect, test } from "bun:test";

import { errorContractOf } from "@stll/errors";

import { runConformance } from "./checks";
import { errorContractChecks } from "./error-contract";
import type { ErrorShellAdapter } from "./error-contract";

// Reference shells, mirroring the two products' mappers:
//  - HTTP: createSafeHandler renders the contract's httpStatus (500 fallback)
//  - RPC:  resultToTRPC renders the contract's trpcCode with a generic
//          message for unmapped errors (never the raw one)
const referenceShells: ErrorShellAdapter = {
  toHttpStatus: (error) => errorContractOf(error)?.httpStatus ?? 500,
  toRpcError: (error) => {
    const entry = errorContractOf(error);
    if (!entry) {
      return { code: "INTERNAL_SERVER_ERROR", message: "Internal server error" };
    }
    return { code: entry.trpcCode, message: error.message };
  },
};

describe("conformance/error-contract with reference shells", () => {
  for (const check of errorContractChecks(referenceShells)) {
    test(check.name, check.run);
  }
});

describe("conformance/error-contract catches broken shells", () => {
  test("a shell that flattens everything to 500/INTERNAL fails the suite", async () => {
    const brokenShells: ErrorShellAdapter = {
      toHttpStatus: () => 500,
      toRpcError: (error) => ({
        code: "INTERNAL_SERVER_ERROR",
        // Worse: it also leaks the raw message.
        message: error.message,
      }),
    };
    const report = await runConformance(errorContractChecks(brokenShells));
    const failedNames = report.failed.map((failure) => failure.name);
    expect(failedNames).toContain(
      "errors: HTTP shell maps every kernel error to its declared status",
    );
    expect(failedNames).toContain(
      "errors: RPC shell maps every kernel error to its declared code",
    );
    expect(failedNames).toContain(
      "errors: an unmapped error's raw message never escapes the RPC shell",
    );
  });

  test("the table-coherence checks pass with no shell adapter at all", async () => {
    const report = await runConformance(errorContractChecks());
    expect(report.failed).toEqual([]);
    expect(report.passed.length).toBeGreaterThanOrEqual(2);
  });
});
