import { Result } from "better-result";

import { PermissionDeniedError } from "@stll/errors";

/**
 * Shared role semantics (reconciliation plan R4). Better Auth's
 * organization plugin stores multi-role membership as a comma-separated
 * string ("admin,sale"); a literal equality check rejects a legitimate
 * multi-role admin. One parser, one vocabulary, both products.
 */

export const parseRoles = (rawRole: string | null | undefined): string[] => {
  if (!rawRole) return [];
  return rawRole
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
};

export const hasAnyRole = (
  rawRole: string | null | undefined,
  allowed: readonly string[],
): boolean => {
  const roles = parseRoles(rawRole);
  return allowed.some((role) => roles.includes(role));
};

export const hasOrgOwnerOrAdmin = (
  rawRole: string | null | undefined,
): boolean => hasAnyRole(rawRole, ["owner", "admin"]);

export type FreshRoleOptions = {
  userId: string;
  organizationId: string;
  /** Roles that pass the gate, e.g. ["owner", "admin"]. */
  allowed: readonly string[];
  /**
   * Fresh read of the member's role from the source of truth — NOT the
   * session cache. A revoked admin must lose access now, not when the
   * cookie cache expires.
   */
  readMemberRole(
    userId: string,
    organizationId: string,
  ): Promise<string | null | undefined>;
};

/**
 * Fail-closed fresh-role gate: re-reads the membership role per call and
 * denies on any read failure (a transient DB blip must degrade to "no",
 * never to a 500 that a retry storm turns into an open gate).
 */
export const requireFreshRole = async (
  options: FreshRoleOptions,
): Promise<Result<void, PermissionDeniedError>> => {
  let rawRole: string | null | undefined;
  try {
    rawRole = await options.readMemberRole(
      options.userId,
      options.organizationId,
    );
  } catch (cause) {
    return Result.err(
      new PermissionDeniedError({
        message: "Role verification unavailable; access denied",
        permission: options.allowed.join("|"),
        cause,
      }),
    );
  }

  if (!hasAnyRole(rawRole, options.allowed)) {
    return Result.err(
      new PermissionDeniedError({
        message: `Requires one of: ${options.allowed.join(", ")}`,
        permission: options.allowed.join("|"),
      }),
    );
  }
  return Result.ok(undefined);
};
