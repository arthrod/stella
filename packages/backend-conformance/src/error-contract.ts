import {
  ERROR_CONTRACT,
  InvalidTransitionError,
  KERNEL_ERROR_TAGS,
  NotFoundError,
  PermissionDeniedError,
  StaleVersionError,
  TenantNotProvisionedError,
  UnauthorizedError,
  UsageLimitExceededError,
} from "@stll/errors";
import type { KernelErrorTag } from "@stll/errors";

import { violation } from "./checks";
import type { ConformanceCheck } from "./checks";

/**
 * Error-contract conformance (suite 2): every kernel `TaggedError` must map
 * to its declared HTTP status through the product's HTTP shell and to its
 * declared tRPC code through the product's RPC shell — and no unmapped
 * error's raw message may escape either shell.
 */

type AnyTagged = Error & { _tag: string; message: string };

export type ErrorShellAdapter = {
  /** Map an error the way the product's HTTP shell does (e.g. createSafeHandler). */
  toHttpStatus?(error: AnyTagged): number;
  /** Map an error the way the product's RPC shell does (e.g. resultToTRPC). */
  toRpcError?(error: AnyTagged): { code: string; message: string };
};

// Representative instance per kernel tag, so shells are exercised with real
// errors rather than synthetic { _tag } literals.
const SAMPLE_ERRORS: Record<KernelErrorTag, () => AnyTagged> = {
  UnauthorizedError: () => new UnauthorizedError({ message: "sign in again" }),
  TenantNotProvisionedError: () =>
    new TenantNotProvisionedError({
      message: "org setup incomplete",
      organizationSlug: "acme",
    }),
  PermissionDeniedError: () =>
    new PermissionDeniedError({
      message: "missing permission",
      permission: "workflow:transition",
    }),
  NotFoundError: () =>
    new NotFoundError({
      message: "workflow wf_1 not found",
      entity: "workflow",
      entityId: "wf_1",
    }),
  StaleVersionError: () =>
    new StaleVersionError({ message: "refresh and retry", expectedSyncVersion: 1 }),
  InvalidTransitionError: () =>
    new InvalidTransitionError({
      message: "stage move not allowed",
      fromStageId: "a",
      toStageId: "b",
    }),
  UsageLimitExceededError: () =>
    new UsageLimitExceededError({
      message: "plan limit reached",
      required: 1,
      available: 0,
      reason: "usage_limit_exceeded",
    }),
};

// The canonical status↔code pairing; a contract entry that disagrees with
// this table is internally incoherent regardless of what shells do.
const STATUS_TO_TRPC: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  402: "PAYMENT_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  412: "PRECONDITION_FAILED",
  413: "PAYLOAD_TOO_LARGE",
  422: "UNPROCESSABLE_CONTENT",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  502: "BAD_GATEWAY",
};

const LEAK_CANARY = "canary-3f9a2e-raw-internal-detail";

class UnmappedConformanceProbeError extends Error {
  readonly _tag = "UnmappedConformanceProbeError";
  constructor() {
    super(`boom: ${LEAK_CANARY}`);
  }
}

export const errorContractChecks = (
  adapter: ErrorShellAdapter = {},
): ConformanceCheck[] => {
  const checks: ConformanceCheck[] = [
    {
      name: "errors: contract table is internally coherent (status ↔ tRPC code)",
      run: () => {
        for (const tag of KERNEL_ERROR_TAGS) {
          const entry = ERROR_CONTRACT[tag];
          const expected = STATUS_TO_TRPC[entry.httpStatus];
          if (expected !== entry.trpcCode) {
            violation(
              `${tag}: HTTP ${entry.httpStatus} pairs with ${expected}, contract says ${entry.trpcCode}`,
            );
          }
        }
        return Promise.resolve();
      },
    },
    {
      name: "errors: client errorTags and i18n keys are unique",
      run: () => {
        const errorTags = KERNEL_ERROR_TAGS.map(
          (tag) => ERROR_CONTRACT[tag].errorTag,
        );
        const i18nKeys = KERNEL_ERROR_TAGS.map(
          (tag) => ERROR_CONTRACT[tag].i18nKey,
        );
        if (new Set(errorTags).size !== errorTags.length) {
          violation("duplicate client errorTag in contract");
        }
        if (new Set(i18nKeys).size !== i18nKeys.length) {
          violation("duplicate i18n key in contract");
        }
        return Promise.resolve();
      },
    },
  ];

  if (adapter.toHttpStatus) {
    const toHttpStatus = adapter.toHttpStatus.bind(adapter);
    checks.push({
      name: "errors: HTTP shell maps every kernel error to its declared status",
      run: () => {
        for (const tag of KERNEL_ERROR_TAGS) {
          const status = toHttpStatus(SAMPLE_ERRORS[tag]());
          const declared = ERROR_CONTRACT[tag].httpStatus;
          if (status !== declared) {
            violation(`${tag}: HTTP shell returned ${status}, contract says ${declared}`);
          }
        }
        return Promise.resolve();
      },
    });
  }

  if (adapter.toRpcError) {
    const toRpcError = adapter.toRpcError.bind(adapter);
    checks.push(
      {
        name: "errors: RPC shell maps every kernel error to its declared code",
        run: () => {
          for (const tag of KERNEL_ERROR_TAGS) {
            const rpc = toRpcError(SAMPLE_ERRORS[tag]());
            const declared = ERROR_CONTRACT[tag].trpcCode;
            if (rpc.code !== declared) {
              violation(`${tag}: RPC shell returned ${rpc.code}, contract says ${declared}`);
            }
          }
          return Promise.resolve();
        },
      },
      {
        name: "errors: an unmapped error's raw message never escapes the RPC shell",
        run: () => {
          const rpc = toRpcError(new UnmappedConformanceProbeError());
          if (rpc.message.includes(LEAK_CANARY)) {
            violation("raw internal message leaked through the RPC shell");
          }
          if (rpc.code !== "INTERNAL_SERVER_ERROR") {
            violation(
              `unmapped error should surface as INTERNAL_SERVER_ERROR, got ${rpc.code}`,
            );
          }
          return Promise.resolve();
        },
      },
    );
  }

  return checks;
};
