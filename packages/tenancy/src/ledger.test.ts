import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  appliedMigrationNames,
  applyPendingMigrations,
  LEDGER_TABLE,
} from "./ledger";
import type { LedgerExecutor, TenantMigration } from "./ledger";

const sqliteExecutor = (db: Database): LedgerExecutor => ({
  execute: (sql) => {
    db.run(sql);
    return Promise.resolve();
  },
  queryRows: (sql) =>
    Promise.resolve(db.query(sql).all() as Record<string, unknown>[]),
});

const MIGRATIONS: TenantMigration[] = [
  {
    name: "0001_probe_docs",
    statements: [
      "CREATE TABLE IF NOT EXISTS probe_docs (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    ],
  },
  {
    name: "0002_probe_index",
    statements: [
      "CREATE INDEX IF NOT EXISTS probe_docs_value_idx ON probe_docs (value)",
    ],
  },
];

const fixedClock = () => "2026-07-11T00:00:00.000Z";

describe("migration ledger", () => {
  test("applies all migrations in order on a fresh database and records them", async () => {
    const db = new Database(":memory:");
    const executor = sqliteExecutor(db);

    const result = await applyPendingMigrations({
      executor,
      migrations: MIGRATIONS,
      now: fixedClock,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw result.error;
    expect(result.value.map((m) => m.name)).toEqual([
      "0001_probe_docs",
      "0002_probe_index",
    ]);
    expect(await appliedMigrationNames(executor)).toEqual(
      new Set(["0001_probe_docs", "0002_probe_index"]),
    );
  });

  test("is idempotent: a second run applies nothing", async () => {
    const db = new Database(":memory:");
    const executor = sqliteExecutor(db);

    await applyPendingMigrations({ executor, migrations: MIGRATIONS });
    const second = await applyPendingMigrations({
      executor,
      migrations: MIGRATIONS,
    });

    expect(second.isOk()).toBe(true);
    if (!second.isOk()) throw second.error;
    expect(second.value).toEqual([]);
  });

  test("applies only the pending tail on a partially migrated database", async () => {
    const db = new Database(":memory:");
    const executor = sqliteExecutor(db);

    await applyPendingMigrations({
      executor,
      migrations: MIGRATIONS.slice(0, 1),
    });
    const result = await applyPendingMigrations({
      executor,
      migrations: MIGRATIONS,
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw result.error;
    expect(result.value.map((m) => m.name)).toEqual(["0002_probe_index"]);
  });

  test("fails fast when the ledger is ahead of the code (unknown applied migration)", async () => {
    const db = new Database(":memory:");
    const executor = sqliteExecutor(db);
    await applyPendingMigrations({ executor, migrations: MIGRATIONS });

    // Simulate old code (knows only 0001) connecting to a newer database.
    const result = await applyPendingMigrations({
      executor,
      migrations: MIGRATIONS.slice(0, 1),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error._tag).toBe("MigrateError");
    expect(result.error.message).toContain("0002_probe_index");
  });

  test("rejects unsafe migration names before touching the database", async () => {
    const db = new Database(":memory:");
    const executor = sqliteExecutor(db);

    const result = await applyPendingMigrations({
      executor,
      migrations: [{ name: "0001'; DROP TABLE x;--", statements: [] }],
    });

    expect(result.isErr()).toBe(true);
    const tables = db
      .query(`SELECT name FROM sqlite_master WHERE name = '${LEDGER_TABLE}'`)
      .all();
    expect(tables).toEqual([]);
  });

  test("a failing statement surfaces as MigrateError naming the migration", async () => {
    const db = new Database(":memory:");
    const executor = sqliteExecutor(db);

    const result = await applyPendingMigrations({
      executor,
      migrations: [
        { name: "0001_bad", statements: ["CREATE BROKEN SYNTAX ("] },
      ],
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.migrationName).toBe("0001_bad");
    // Nothing recorded for the failed migration.
    expect(await appliedMigrationNames(executor)).toEqual(new Set());
  });
});
