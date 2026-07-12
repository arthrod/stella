import { Result } from "better-result";

import { MigrateError } from "./port";
import type { AppliedMigration } from "./port";

/**
 * Per-tenant migration ledger (ADR-0002 §3). Every tenant database carries a
 * `schema_migrations` table recording exactly which migrations it has; the
 * driver applies pending ones explicitly and reports them. This replaces
 * blind connect-time "auto-heal" DDL: drift is tracked and closed, never
 * papered over. Semantics mirror boot-time `assertMigrationsApplied()`
 * fail-fast: a ledger the code doesn't recognize is an error, not a shrug.
 */

export const LEDGER_TABLE = "schema_migrations";

export type TenantMigration = {
  /** Stable, ordered identifier, e.g. "0002_notifications". */
  name: string;
  /** DDL/DML statements executed in order. Each must be idempotent-safe to retry after a crash. */
  statements: readonly string[];
};

/**
 * Minimal SQL seam the ledger needs. Drivers adapt their client (libsql,
 * postgres, bun:sqlite in tests) to this pair of methods.
 */
export interface LedgerExecutor {
  execute(sql: string): Promise<unknown>;
  queryRows(sql: string): Promise<Record<string, unknown>[]>;
}

// Migration names are code-controlled, but they are interpolated into SQL
// (portably across sqlite/postgres placeholders), so they are validated
// against a strict identifier alphabet instead of being escaped.
const SAFE_MIGRATION_NAME = /^[A-Za-z0-9_.-]+$/;

const quote = (name: string): string => `'${name}'`;

export const ensureLedgerTable = async (
  executor: LedgerExecutor,
): Promise<void> => {
  await executor.execute(
    `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)`,
  );
};

export const appliedMigrationNames = async (
  executor: LedgerExecutor,
): Promise<Set<string>> => {
  const rows = await executor.queryRows(
    `SELECT name FROM ${LEDGER_TABLE} ORDER BY name`,
  );
  return new Set(rows.map((row) => String(row["name"])));
};

export type ApplyPendingOptions = {
  executor: LedgerExecutor;
  migrations: readonly TenantMigration[];
  /** Injectable clock for deterministic tests. */
  now?: (() => string) | undefined;
};

/**
 * Ensure the ledger exists, diff it against the known migration list, apply
 * the pending ones in list order, and record each in the ledger. Returns the
 * applied set (empty when up to date).
 *
 * Fails (without applying anything) when the ledger records a migration the
 * code does not know: that means the database is ahead of the code — the
 * deploy-order bug `assertMigrationsApplied()` exists to catch.
 */
export const applyPendingMigrations = async ({
  executor,
  migrations,
  now = () => new Date().toISOString(),
}: ApplyPendingOptions): Promise<Result<AppliedMigration[], MigrateError>> => {
  for (const migration of migrations) {
    if (!SAFE_MIGRATION_NAME.test(migration.name)) {
      return Result.err(
        new MigrateError({
          message: `Invalid migration name: ${JSON.stringify(migration.name)}`,
          migrationName: migration.name,
        }),
      );
    }
  }

  await ensureLedgerTable(executor);
  const applied = await appliedMigrationNames(executor);

  const known = new Set(migrations.map((migration) => migration.name));
  for (const name of applied) {
    if (!known.has(name)) {
      return Result.err(
        new MigrateError({
          message: `Ledger records unknown migration "${name}"; database is ahead of this code`,
          migrationName: name,
        }),
      );
    }
  }

  const appliedNow: AppliedMigration[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    for (const statement of migration.statements) {
      try {
        await executor.execute(statement);
      } catch (cause) {
        return Result.err(
          new MigrateError({
            message: `Migration "${migration.name}" failed`,
            migrationName: migration.name,
            cause,
          }),
        );
      }
    }

    const appliedAt = now();
    await executor.execute(
      `INSERT INTO ${LEDGER_TABLE} (name, applied_at) VALUES (${quote(migration.name)}, ${quote(appliedAt)})`,
    );
    appliedNow.push({ name: migration.name, appliedAt });
  }

  return Result.ok(appliedNow);
};
