import { TaggedError } from "better-result";

/**
 * Kernel error taxonomy — the transport-visible failure classes every
 * product shell (HTTP handler or RPC procedure) must map identically.
 * The mapping itself lives in ./contract.ts; these classes carry the
 * structured context a client needs to say what to do next.
 */

/** Caller has no valid session. */
export class UnauthorizedError extends TaggedError("UnauthorizedError")<{
  message: string;
  cause?: unknown;
}>() {}

/**
 * Caller is authenticated but lacks a permission. `permission` names the
 * missing statement so the client can say which permission, not just "no".
 */
export class PermissionDeniedError extends TaggedError(
  "PermissionDeniedError",
)<{
  message: string;
  permission?: string;
  cause?: unknown;
}>() {}

/** The referenced entity does not exist (or is not visible to the caller). */
export class NotFoundError extends TaggedError("NotFoundError")<{
  message: string;
  entity?: string;
  entityId?: string;
}>() {}

/**
 * The organization's tenant data store is not (yet) provisioned. Setup is
 * incomplete rather than forbidden; clients should surface what to do next.
 */
export class TenantNotProvisionedError extends TaggedError(
  "TenantNotProvisionedError",
)<{
  message: string;
  organizationSlug?: string;
  organizationId?: string;
}>() {}

/**
 * Optimistic-lock failure: the caller's version token no longer matches the
 * row (`WHERE id = ? AND sync_version = ?` affected zero rows). Clients
 * offer refresh-and-retry instead of silently clobbering.
 */
export class StaleVersionError extends TaggedError("StaleVersionError")<{
  message: string;
  expectedSyncVersion?: number;
}>() {}

/** A requested state-machine stage move is not an allowed transition. */
export class InvalidTransitionError extends TaggedError(
  "InvalidTransitionError",
)<{
  message: string;
  fromStageId?: string;
  toStageId?: string;
  reason?: string;
}>() {}

export const USAGE_LIMIT_EXCEEDED_REASONS = [
  "no_entitlement",
  "usage_limit_exceeded",
  "entitlement_inactive",
] as const;

export type UsageLimitExceededReason =
  (typeof USAGE_LIMIT_EXCEEDED_REASONS)[number];

/**
 * Plan limit reached. `required`/`available` let the client render an
 * "x of y units left" modal without parsing the message.
 */
export class UsageLimitExceededError extends TaggedError(
  "UsageLimitExceededError",
)<{
  message: string;
  required: number;
  available: number;
  reason: UsageLimitExceededReason;
}>() {}
