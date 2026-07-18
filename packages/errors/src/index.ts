import { TaggedError } from "better-result";

export {
  contractFor,
  ERROR_CONTRACT,
  errorContractOf,
  isKernelErrorTag,
  KERNEL_ERROR_TAGS,
  type ErrorContractEntry,
  type ErrorContractHttpStatus,
  type ErrorContractTrpcCode,
  type KernelErrorTag,
} from "./contract";
export {
  InvalidTransitionError,
  NotFoundError,
  PermissionDeniedError,
  StaleVersionError,
  TenantNotProvisionedError,
  UnauthorizedError,
  USAGE_LIMIT_EXCEEDED_REASONS,
  UsageLimitExceededError,
  type UsageLimitExceededReason,
} from "./kernel-errors";

/**
 * HTTP/network failure at a raw fetch boundary. Carries protocol details for
 * structured logging while keeping callers free to wrap user-facing messages.
 */
export class FetchBoundaryError extends TaggedError("FetchBoundaryError")<{
  url: string;
  status?: number;
  statusText?: string;
  body?: string;
  message: string;
  cause?: unknown;
}>() {}
