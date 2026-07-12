import { TaggedError } from "better-result";

import type { OrganizationRef, TenantStore } from "@stll/tenancy";

/**
 * The no-orphan-orgs provisioning hook (reconciliation plan R4): when
 * organization creation succeeds in the auth store but tenant provisioning
 * fails, the auth rows are rolled back and the creation call fails loudly.
 * An organization either exists fully (auth rows + tenant store) or not at
 * all — never as an auth-only husk whose first request 500s.
 *
 * Shaped for Better Auth's `organizationCreation.afterCreate` hook: throw
 * to abort. Wire it as:
 *
 *   organization({
 *     organizationCreation: {
 *       afterCreate: createOrganizationProvisioningHook({ tenantStore, rollback }),
 *     },
 *   })
 */

export class OrganizationProvisioningError extends TaggedError(
  "OrganizationProvisioningError",
)<{
  message: string;
  organizationId: string;
  rollback: "clean" | "failed";
  cause?: unknown;
}>() {}

export type ProvisioningHookOptions = {
  tenantStore: Pick<TenantStore<unknown>, "provision">;
  /**
   * Remove the just-created auth rows (organization + creator membership).
   * Product-supplied: the auth schema lives product-side.
   */
  rollback(organizationId: string): Promise<void>;
  log?: (message: string, context?: Record<string, unknown>) => void;
};

export type CreatedOrganization = {
  organization: { id: string; slug: string };
};

export const createOrganizationProvisioningHook = (
  options: ProvisioningHookOptions,
): ((created: CreatedOrganization) => Promise<void>) => {
  const log = options.log ?? (() => undefined);

  return async ({ organization }) => {
    const ref: OrganizationRef = {
      id: organization.id,
      slug: organization.slug,
    };
    const provisioned = await options.tenantStore.provision(ref);
    if (provisioned.isOk()) return;

    log("tenant provisioning failed; rolling back organization", {
      organizationId: organization.id,
    });
    let rollbackOutcome: "clean" | "failed" = "clean";
    try {
      await options.rollback(organization.id);
    } catch (rollbackCause) {
      rollbackOutcome = "failed";
      log("organization rollback failed — manual cleanup required", {
        organizationId: organization.id,
        cause: String(rollbackCause),
      });
    }

    throw new OrganizationProvisioningError({
      message:
        rollbackOutcome === "clean"
          ? "Organization creation failed: tenant store could not be provisioned (rolled back)"
          : "Organization creation failed AND rollback failed — orphaned auth rows need cleanup",
      organizationId: organization.id,
      rollback: rollbackOutcome,
      cause: provisioned.error,
    });
  };
};
