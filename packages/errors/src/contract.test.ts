import { describe, expect, test } from "bun:test";

import {
  ERROR_CONTRACT,
  errorContractOf,
  isKernelErrorTag,
  KERNEL_ERROR_TAGS,
} from "./contract";
import {
  InvalidTransitionError,
  NotFoundError,
  PermissionDeniedError,
  StaleVersionError,
  TenantNotProvisionedError,
  UnauthorizedError,
  UsageLimitExceededError,
} from "./kernel-errors";

const kernelErrorInstances = [
  new UnauthorizedError({ message: "sign in again" }),
  new TenantNotProvisionedError({
    message: "org setup incomplete",
    organizationSlug: "acme",
  }),
  new PermissionDeniedError({
    message: "missing permission",
    permission: "workflow:transition",
  }),
  new NotFoundError({
    message: "workflow wf_1 not found",
    entity: "workflow",
    entityId: "wf_1",
  }),
  new StaleVersionError({
    message: "someone else changed this",
    expectedSyncVersion: 4,
  }),
  new InvalidTransitionError({
    message: "that stage move isn't allowed",
    fromStageId: "stage_a",
    toStageId: "stage_b",
  }),
  new UsageLimitExceededError({
    message: "plan limit reached",
    required: 2,
    available: 1,
    reason: "usage_limit_exceeded",
  }),
];

describe("error contract", () => {
  test("every kernel error class maps to a contract entry", () => {
    for (const error of kernelErrorInstances) {
      const entry = errorContractOf(error);
      expect(entry).toBeDefined();
      expect(entry?.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });

  test("contract keys and KERNEL_ERROR_TAGS agree exactly", () => {
    expect(Object.keys(ERROR_CONTRACT).toSorted()).toEqual(
      [...KERNEL_ERROR_TAGS].toSorted(),
    );
  });

  test("declared status/tRPC pairs match the reconciliation plan table", () => {
    expect(ERROR_CONTRACT.UnauthorizedError.httpStatus).toBe(401);
    expect(ERROR_CONTRACT.UnauthorizedError.trpcCode).toBe("UNAUTHORIZED");

    expect(ERROR_CONTRACT.TenantNotProvisionedError.httpStatus).toBe(412);
    expect(ERROR_CONTRACT.TenantNotProvisionedError.trpcCode).toBe(
      "PRECONDITION_FAILED",
    );

    expect(ERROR_CONTRACT.PermissionDeniedError.httpStatus).toBe(403);
    expect(ERROR_CONTRACT.PermissionDeniedError.trpcCode).toBe("FORBIDDEN");

    expect(ERROR_CONTRACT.NotFoundError.httpStatus).toBe(404);
    expect(ERROR_CONTRACT.NotFoundError.trpcCode).toBe("NOT_FOUND");

    expect(ERROR_CONTRACT.StaleVersionError.httpStatus).toBe(409);
    expect(ERROR_CONTRACT.StaleVersionError.trpcCode).toBe("CONFLICT");

    expect(ERROR_CONTRACT.InvalidTransitionError.httpStatus).toBe(400);
    expect(ERROR_CONTRACT.InvalidTransitionError.trpcCode).toBe("BAD_REQUEST");

    expect(ERROR_CONTRACT.UsageLimitExceededError.httpStatus).toBe(402);
    expect(ERROR_CONTRACT.UsageLimitExceededError.trpcCode).toBe(
      "PAYMENT_REQUIRED",
    );
  });

  test("client errorTags are unique and kebab-case", () => {
    const tags = Object.values(ERROR_CONTRACT).map((entry) => entry.errorTag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) {
      expect(tag).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  test("i18n keys are unique and namespaced under errors.", () => {
    const keys = Object.values(ERROR_CONTRACT).map((entry) => entry.i18nKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key.startsWith("errors.")).toBe(true);
    }
  });

  test("isKernelErrorTag rejects unknown tags and errorContractOf returns undefined", () => {
    expect(isKernelErrorTag("SomeRandomError")).toBe(false);
    expect(errorContractOf({ _tag: "SomeRandomError" })).toBeUndefined();
    expect(isKernelErrorTag("StaleVersionError")).toBe(true);
  });

  test("usage-limit error carries the structured detail the 402 modal needs", () => {
    const error = new UsageLimitExceededError({
      message: "plan limit reached",
      required: 5,
      available: 0,
      reason: "no_entitlement",
    });
    expect(error.required).toBe(5);
    expect(error.available).toBe(0);
    expect(error.reason).toBe("no_entitlement");
    expect(error._tag).toBe("UsageLimitExceededError");
  });
});
