/**
 * The error-contract table: the single source of truth mapping each kernel
 * `TaggedError` tag to its HTTP status, tRPC code, stable client `errorTag`,
 * and i18n message key. Product shells consume this table — an HTTP handler
 * renders `httpStatus`, an RPC shell renders `trpcCode` — so the same
 * failure means the same thing on every transport.
 *
 * tRPC codes are string literals (not imported from @trpc/server) so this
 * package stays dependency-free beyond better-result; the conformance suite
 * verifies each literal is a real tRPC code in consumers that have tRPC.
 */

export type ErrorContractHttpStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 409
  | 412
  | 413
  | 422
  | 429
  | 500
  | 502;

export type ErrorContractTrpcCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "PAYMENT_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UNPROCESSABLE_CONTENT"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_SERVER_ERROR"
  | "BAD_GATEWAY";

export type ErrorContractEntry = {
  httpStatus: ErrorContractHttpStatus;
  trpcCode: ErrorContractTrpcCode;
  /** Stable, kebab-case identifier clients switch on; never renamed. */
  errorTag: string;
  /** Message key the frontend resolves; the raw server message never ships. */
  i18nKey: string;
  /** What the client should tell the user to do next. */
  uxMeaning: string;
};

export const ERROR_CONTRACT = {
  UnauthorizedError: {
    httpStatus: 401,
    trpcCode: "UNAUTHORIZED",
    errorTag: "unauthorized",
    i18nKey: "errors.unauthorized",
    uxMeaning: "sign in again",
  },
  TenantNotProvisionedError: {
    httpStatus: 412,
    trpcCode: "PRECONDITION_FAILED",
    errorTag: "tenant-not-provisioned",
    i18nKey: "errors.tenantNotProvisioned",
    uxMeaning: "organization setup incomplete; show what to do",
  },
  PermissionDeniedError: {
    httpStatus: 403,
    trpcCode: "FORBIDDEN",
    errorTag: "permission-denied",
    i18nKey: "errors.permissionDenied",
    uxMeaning: "you can't do this; say which permission",
  },
  NotFoundError: {
    httpStatus: 404,
    trpcCode: "NOT_FOUND",
    errorTag: "not-found",
    i18nKey: "errors.notFound",
    uxMeaning: "the referenced item doesn't exist; check the link or refresh",
  },
  StaleVersionError: {
    httpStatus: 409,
    trpcCode: "CONFLICT",
    errorTag: "stale-version",
    i18nKey: "errors.staleVersion",
    uxMeaning: "someone else changed this; refresh and retry",
  },
  InvalidTransitionError: {
    httpStatus: 400,
    trpcCode: "BAD_REQUEST",
    errorTag: "invalid-transition",
    i18nKey: "errors.invalidTransition",
    uxMeaning: "that stage move isn't allowed; say why",
  },
  UsageLimitExceededError: {
    httpStatus: 402,
    trpcCode: "PAYMENT_REQUIRED",
    errorTag: "usage-limit-exceeded",
    i18nKey: "errors.usageLimitExceeded",
    uxMeaning: "plan limit reached; show upgrade path",
  },
} as const satisfies Record<string, ErrorContractEntry>;

export type KernelErrorTag = keyof typeof ERROR_CONTRACT;

export const KERNEL_ERROR_TAGS = Object.keys(ERROR_CONTRACT) as [
  KernelErrorTag,
  ...KernelErrorTag[],
];

export const isKernelErrorTag = (tag: string): tag is KernelErrorTag =>
  tag in ERROR_CONTRACT;

export const contractFor = (tag: KernelErrorTag): ErrorContractEntry =>
  ERROR_CONTRACT[tag];

/**
 * Contract entry for a tagged error instance, or undefined when the tag is
 * not part of the kernel contract (shells then fall back to their generic
 * 500/INTERNAL_SERVER_ERROR path; raw messages never escape unmapped).
 */
export const errorContractOf = (error: {
  _tag: string;
}): ErrorContractEntry | undefined =>
  isKernelErrorTag(error._tag) ? ERROR_CONTRACT[error._tag] : undefined;
