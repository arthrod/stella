import { TaggedError } from "better-result";
import type { Result } from "better-result";

/**
 * The tenancy port (reconciliation plan R1, ADR-0002): services consume this
 * interface and never learn which isolation model backs it. Two drivers ship
 * with the kernel — `driver-rls-postgres` (single database, row-level
 * security) and `driver-db-per-org` (registry-resolved physical database per
 * organization). Which driver a deployment uses is policy, not architecture.
 */

export type OrganizationId = string;

export type OrganizationRef = {
  id: OrganizationId;
  slug: string;
};

export type AppliedMigration = {
  name: string;
  appliedAt: string;
};

export class ProvisionError extends TaggedError("ProvisionError")<{
  message: string;
  organizationId: OrganizationId;
  cause?: unknown;
}>() {}

export class DestroyError extends TaggedError("DestroyError")<{
  message: string;
  organizationId: OrganizationId;
  cause?: unknown;
}>() {}

export class MigrateError extends TaggedError("MigrateError")<{
  message: string;
  organizationId?: OrganizationId;
  migrationName?: string;
  cause?: unknown;
}>() {}

export interface TenantStore<TDb> {
  /**
   * Run `fn` against the tenant-scoped database handle. Throws
   * `TenantNotProvisionedError` (from `@stll/errors`) when the organization
   * has no tenant store; shells map it per the error contract (HTTP 412 /
   * tRPC PRECONDITION_FAILED).
   */
  withTenant<T>(
    organizationId: OrganizationId,
    fn: (db: TDb) => Promise<T>,
  ): Promise<T>;

  /** Create the tenant store for a new organization. Must not leave orphans on failure. */
  provision(org: OrganizationRef): Promise<Result<void, ProvisionError>>;

  /** Remove the organization's tenant store (GDPR delete path). Idempotent. */
  destroy(
    organizationId: OrganizationId,
  ): Promise<Result<void, DestroyError>>;

  /** Apply pending migrations for this organization's store; report what was applied. */
  migrate(
    organizationId: OrganizationId,
  ): Promise<Result<AppliedMigration[], MigrateError>>;
}
