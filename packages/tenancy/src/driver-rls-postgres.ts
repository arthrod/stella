import { Result } from "better-result";

import { applyPendingMigrations } from "./ledger";
import type { LedgerExecutor, TenantMigration } from "./ledger";
import { DestroyError, MigrateError, ProvisionError } from "./port";
import type { OrganizationId, TenantStore } from "./port";

/**
 * Row-level-security driver: one shared Postgres, per-transaction scoping
 * (generalized from `apps/api/src/db/scoped.ts`). `withTenant` opens a
 * transaction, switches to the restricted role, sets the organization GUC,
 * and hands the transaction to the service. RLS policies keyed on the GUC do
 * the isolation; the adversarial probes in the conformance kit prove it.
 *
 * This driver is deliberately free of any ORM dependency: the database seam
 * is "something that can run a function inside a transaction whose handle
 * can execute SQL", which every Drizzle/pg/PGlite instance satisfies.
 */

type SqlCapableTx = {
  execute(query: string): PromiseLike<unknown>;
};

export type TransactionalDatabase<TTx extends SqlCapableTx> = {
  transaction<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
};

// Role and GUC names are configuration (code-controlled), but they are
// interpolated into SQL, so hold them to identifier discipline anyway.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_.]*$/i;
// Organization ids reach this driver from session state; they end up inside
// a set_config() literal, so reject anything outside the UUID/slug alphabet
// instead of trying to escape it.
const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9_-]+$/;

export type RlsPostgresStoreOptions<TTx extends SqlCapableTx> = {
  database: TransactionalDatabase<TTx>;
  /** Restricted role RLS policies apply to, e.g. "stella". */
  role: string;
  /** GUC the policies read, e.g. "app.organization_id". */
  organizationIdSetting: string;
  /**
   * Extra per-transaction scope (user id GUC, workspace ids GUC, …).
   * Runs after role + organization are set.
   */
  extendScope?(tx: TTx, organizationId: OrganizationId): Promise<void>;
  /**
   * Tenant deletion under RLS is schema-specific (delete rows across tables,
   * or archive-and-purge). The application supplies it; without it,
   * `destroy` reports the missing capability instead of guessing.
   */
  destroyTenant?(organizationId: OrganizationId): Promise<void>;
  /**
   * Schema migrations are shared in the RLS model (one database). `migrate`
   * runs the ledger against this executor regardless of the organization
   * argument, so fleet tooling can treat both drivers identically.
   */
  migrationExecutor?: LedgerExecutor;
  migrations?: readonly TenantMigration[];
  now?: () => string;
};

export const createRlsPostgresTenantStore = <TTx extends SqlCapableTx>(
  options: RlsPostgresStoreOptions<TTx>,
): TenantStore<TTx> => {
  if (!SAFE_IDENTIFIER.test(options.role)) {
    throw new Error(`Invalid role identifier: ${JSON.stringify(options.role)}`);
  }
  if (!SAFE_IDENTIFIER.test(options.organizationIdSetting)) {
    throw new Error(
      `Invalid setting identifier: ${JSON.stringify(options.organizationIdSetting)}`,
    );
  }

  return {
    async withTenant(organizationId, fn) {
      if (!SAFE_ORGANIZATION_ID.test(organizationId)) {
        throw new Error(
          `Invalid organization id: ${JSON.stringify(organizationId)}`,
        );
      }
      return await options.database.transaction(async (tx) => {
        await tx.execute(
          `SELECT set_config('role', '${options.role}', true), ` +
            `set_config('${options.organizationIdSetting}', '${organizationId}', true)`,
        );
        if (options.extendScope) {
          await options.extendScope(tx, organizationId);
        }
        return await fn(tx);
      });
    },

    // Rows are scoped lazily under RLS; there is nothing to create per org.
    async provision(org) {
      if (!SAFE_ORGANIZATION_ID.test(org.id)) {
        return Result.err(
          new ProvisionError({
            message: `Invalid organization id: ${JSON.stringify(org.id)}`,
            organizationId: org.id,
          }),
        );
      }
      return Result.ok(undefined);
    },

    async destroy(organizationId) {
      if (!options.destroyTenant) {
        return Result.err(
          new DestroyError({
            message: "This deployment cannot delete tenant data (no destroyTenant capability)",
            organizationId,
          }),
        );
      }
      try {
        await options.destroyTenant(organizationId);
      } catch (cause) {
        return Result.err(
          new DestroyError({
            message: "Deleting tenant data failed",
            organizationId,
            cause,
          }),
        );
      }
      return Result.ok(undefined);
    },

    async migrate(organizationId) {
      if (!options.migrationExecutor || !options.migrations) {
        return Result.err(
          new MigrateError({
            message: "This store has no migration executor configured",
            organizationId,
          }),
        );
      }
      return await applyPendingMigrations({
        executor: options.migrationExecutor,
        migrations: options.migrations,
        now: options.now,
      });
    },
  };
};
