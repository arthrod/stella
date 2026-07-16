/**
 * Shared Better Auth preset surface (reconciliation plan R4).
 *
 * One *model*, not one *instance*: each product supplies its own db adapter,
 * tenant store, and product plugins. The kit owns the identity vocabulary
 * that must stay identical across Stoa/CLM, Custodia, Magus (and any gated
 * Scriba entry): org provisioning rollback, role parsing, fresh-role gate,
 * and session context shape.
 *
 * This factory does not call `betterAuth()` itself — products retain their
 * BA version pin and edge wiring — but documents and returns the shared
 * config fragments they must compose.
 */

import {
  createOrganizationProvisioningHook,
  type ProvisioningHookOptions,
} from "./provisioning";
import { hasAnyRole, hasOrgOwnerOrAdmin, parseRoles, requireFreshRole } from "./roles";
import { resolveSessionContext, type PlatformSessionContext } from "./session-context";

/** Shared role vocabulary both products recognize (R4). */
export const PLATFORM_ROLE_VOCABULARY = [
  "owner",
  "admin",
  "member",
  "intern",
  "external",
  "sale",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLE_VOCABULARY)[number];

export type PlatformAuthPorts = {
  /**
   * Tenant provision + rollback for `afterCreateOrganization`.
   * Required for the no-orphan-orgs rule.
   */
  provisioning: ProvisioningHookOptions;
  /**
   * Product-specific BA plugins (Stella: emailOTP/jwt; Cicero: admin/polar).
   * Opaque to the kit — only the *order of composition* is shared.
   */
  productPlugins?: readonly unknown[];
};

export type PlatformAuthModel = {
  /** Kit version so consumers can assert they share one model. */
  modelId: "stll-auth-kit/v1";
  roleVocabulary: readonly PlatformRole[];
  /** BA organization plugin defaults products should pass through. */
  organizationDefaults: {
    teamsEnabled: true;
    /** Wire as `organizationCreation.afterCreate` (or equivalent). */
    afterCreate: ReturnType<typeof createOrganizationProvisioningHook>;
  };
  roles: {
    parseRoles: typeof parseRoles;
    hasAnyRole: typeof hasAnyRole;
    hasOrgOwnerOrAdmin: typeof hasOrgOwnerOrAdmin;
    requireFreshRole: typeof requireFreshRole;
  };
  session: {
    resolveSessionContext: typeof resolveSessionContext;
  };
  productPlugins: readonly unknown[];
};

/**
 * Build the shared platform auth model. Products call this once at auth
 * construction and compose `organizationDefaults` + `roles` into their
 * Better Auth instance and procedure gates.
 */
export function createPlatformAuth(ports: PlatformAuthPorts): PlatformAuthModel {
  return {
    modelId: "stll-auth-kit/v1",
    roleVocabulary: PLATFORM_ROLE_VOCABULARY,
    organizationDefaults: {
      teamsEnabled: true,
      afterCreate: createOrganizationProvisioningHook(ports.provisioning),
    },
    roles: {
      parseRoles,
      hasAnyRole,
      hasOrgOwnerOrAdmin,
      requireFreshRole,
    },
    session: {
      resolveSessionContext,
    },
    productPlugins: ports.productPlugins ?? [],
  };
}

export type { PlatformSessionContext };
