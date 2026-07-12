import { Result } from "better-result";

import { TenantNotProvisionedError } from "@stll/errors";

import { applyPendingMigrations } from "./ledger";
import type { LedgerExecutor, TenantMigration } from "./ledger";
import { DestroyError, MigrateError, ProvisionError } from "./port";
import type {
  AppliedMigration,
  OrganizationId,
  OrganizationRef,
  TenantStore,
} from "./port";

/**
 * Physical-isolation driver: one database per organization, resolved through
 * a server-trusted registry (generalized from the Turso-per-org design:
 * registry row with encrypted credentials → open per-org connection →
 * enforce invariants → serve). Connect-time auto-heal is replaced by the
 * migration ledger: pending migrations are applied explicitly on the first
 * connection after a deploy and reported, never silently.
 */

export type RegistryEntry = {
  organizationId: OrganizationId;
  slug: string;
  /** Driver-opaque locator (URL, database name, encrypted credentials, …). */
  locator: Record<string, unknown>;
};

export interface TenantRegistry {
  get(organizationId: OrganizationId): Promise<RegistryEntry | undefined>;
  put(entry: RegistryEntry): Promise<void>;
  delete(organizationId: OrganizationId): Promise<void>;
}

export type TenantConnection<TDb> = {
  db: TDb;
  executor: LedgerExecutor;
  close?: () => void | Promise<void>;
};

export type DbPerOrgStoreOptions<TDb> = {
  registry: TenantRegistry;
  /** Open a connection to an existing tenant database. */
  openConnection(entry: RegistryEntry): Promise<TenantConnection<TDb>>;
  /**
   * Connection-time invariants (e.g. `PRAGMA foreign_keys = ON` asserted, as
   * the workflow schema mandates). Failures fail the request closed.
   */
  onConnect?(connection: TenantConnection<TDb>): Promise<void>;
  /** Create the physical database for a new org (e.g. fork-from-template + token grant). */
  createDatabase?(org: OrganizationRef): Promise<RegistryEntry>;
  /** Drop the physical database (GDPR delete). */
  dropDatabase?(entry: RegistryEntry): Promise<void>;
  /** Ordered, full migration history for tenant databases. */
  migrations: readonly TenantMigration[];
  /** Injectable clock passed through to the ledger (deterministic tests). */
  now?: () => string;
};

export const createDbPerOrgTenantStore = <TDb>(
  options: DbPerOrgStoreOptions<TDb>,
): TenantStore<TDb> => {
  // One ledger pass per (store × org): first use after a deploy applies
  // pending migrations; later uses short-circuit. `migrate()` always re-runs
  // (it is the eager/fleet path) and re-primes the cache.
  const migratedOrgs = new Set<OrganizationId>();

  const openFor = async (
    entry: RegistryEntry,
  ): Promise<TenantConnection<TDb>> => {
    const connection = await options.openConnection(entry);
    if (options.onConnect) await options.onConnect(connection);
    return connection;
  };

  const closeQuietly = async (connection: TenantConnection<TDb>) => {
    await connection.close?.();
  };

  const runLedger = async (
    connection: TenantConnection<TDb>,
    organizationId: OrganizationId,
  ): Promise<Result<AppliedMigration[], MigrateError>> => {
    const applied = await applyPendingMigrations({
      executor: connection.executor,
      migrations: options.migrations,
      now: options.now,
    });
    if (applied.isOk()) migratedOrgs.add(organizationId);
    return applied;
  };

  return {
    async withTenant(organizationId, fn) {
      const entry = await options.registry.get(organizationId);
      if (!entry) {
        throw new TenantNotProvisionedError({
          message: `No tenant database provisioned for organization '${organizationId}'`,
          organizationId,
        });
      }

      const connection = await openFor(entry);
      try {
        if (!migratedOrgs.has(organizationId)) {
          const applied = await runLedger(connection, organizationId);
          if (applied.isErr()) throw applied.error;
        }
        return await fn(connection.db);
      } finally {
        await closeQuietly(connection);
      }
    },

    async provision(org) {
      if (!options.createDatabase) {
        return Result.err(
          new ProvisionError({
            message: "This deployment cannot create tenant databases (no createDatabase capability)",
            organizationId: org.id,
          }),
        );
      }
      const existing = await options.registry.get(org.id);
      if (existing) {
        return Result.err(
          new ProvisionError({
            message: `Organization '${org.id}' is already provisioned`,
            organizationId: org.id,
          }),
        );
      }

      let entry: RegistryEntry;
      try {
        entry = await options.createDatabase(org);
      } catch (cause) {
        return Result.err(
          new ProvisionError({
            message: "Creating the tenant database failed",
            organizationId: org.id,
            cause,
          }),
        );
      }

      // Bring the fresh database fully up to date BEFORE registering it, so
      // a half-provisioned org can never be resolved by withTenant (the
      // no-orphans rule the auth-kit provisioning hook relies on).
      try {
        const connection = await openFor(entry);
        try {
          const applied = await runLedger(connection, org.id);
          if (applied.isErr()) throw applied.error;
        } finally {
          await closeQuietly(connection);
        }
        await options.registry.put(entry);
      } catch (cause) {
        migratedOrgs.delete(org.id);
        try {
          await options.dropDatabase?.(entry);
        } catch {
          // Rollback is best-effort; the provision error below carries the
          // original cause and the operator alert includes the entry.
        }
        return Result.err(
          new ProvisionError({
            message: "Provisioning failed after database creation; rolled back",
            organizationId: org.id,
            cause,
          }),
        );
      }

      return Result.ok(undefined);
    },

    async destroy(organizationId) {
      const entry = await options.registry.get(organizationId);
      if (!entry) return Result.ok(undefined); // idempotent delete

      if (!options.dropDatabase) {
        return Result.err(
          new DestroyError({
            message: "This deployment cannot drop tenant databases (no dropDatabase capability)",
            organizationId,
          }),
        );
      }

      try {
        await options.dropDatabase(entry);
        await options.registry.delete(organizationId);
        migratedOrgs.delete(organizationId);
      } catch (cause) {
        return Result.err(
          new DestroyError({
            message: "Destroying the tenant database failed",
            organizationId,
            cause,
          }),
        );
      }
      return Result.ok(undefined);
    },

    async migrate(organizationId) {
      const entry = await options.registry.get(organizationId);
      if (!entry) {
        return Result.err(
          new MigrateError({
            message: `No tenant database provisioned for organization '${organizationId}'`,
            organizationId,
          }),
        );
      }
      const connection = await openFor(entry);
      try {
        return await runLedger(connection, organizationId);
      } finally {
        await closeQuietly(connection);
      }
    },
  };
};
