/**
 * The shared session-context struct (reconciliation plan R4): the one shape
 * both products' guarded procedures/macros consume, so "who is acting, in
 * which organization, with which membership role" reads identically in a
 * tRPC `tenantProcedure` and an Elysia workspace macro.
 */

export type PlatformSessionContext = {
  userId: string;
  /** Platform-level role from the admin plugin (e.g. "admin"), if any. */
  platformRole?: string | undefined;
  activeOrganizationId: string;
  /** Resolved org slug — session stores the id; resolve once per request. */
  organizationSlug: string;
  /** Raw membership role string (may be comma-separated multi-role). */
  memberRole?: string | undefined;
};

export type RawSessionShape = {
  user?: { id?: string; role?: string } | undefined;
  session?: { activeOrganizationId?: string } | undefined;
  member?: { role?: string } | undefined;
  /** Resolved slug, attached by the product's org-resolution middleware. */
  activeOrganization?: string | undefined;
};

/**
 * Narrow a raw session into the platform context, or explain what is
 * missing. Products map the `reason` to their transport's error
 * (UNAUTHORIZED / PRECONDITION_FAILED) via the error contract.
 */
export type SessionContextResolution =
  | { ok: true; context: PlatformSessionContext }
  | { ok: false; reason: "unauthenticated" | "no-active-organization" };

export const resolveSessionContext = (
  raw: RawSessionShape | null | undefined,
): SessionContextResolution => {
  const userId = raw?.user?.id;
  if (!userId) {
    return { ok: false, reason: "unauthenticated" };
  }
  const activeOrganizationId = raw?.session?.activeOrganizationId;
  const organizationSlug = raw?.activeOrganization;
  if (!activeOrganizationId || !organizationSlug) {
    return { ok: false, reason: "no-active-organization" };
  }
  return {
    ok: true,
    context: {
      userId,
      platformRole: raw?.user?.role,
      activeOrganizationId,
      organizationSlug,
      memberRole: raw?.member?.role,
    },
  };
};
