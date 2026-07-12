import { beforeAll, describe, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

import { createRlsPostgresTenantStore } from "@stll/tenancy";
import type { LedgerExecutor, TenantMigration } from "@stll/tenancy";

import { tenantIsolationChecks } from "./tenant-isolation";

// Reference proof: the RLS driver passes the same isolation probes against
// real row-level security — actual Postgres (PGlite), an actual restricted
// role, an actual policy keyed on the organization GUC. This is the "write
// as org A, read as org B, assert zero rows" bar from the plan, enforced by
// the database engine rather than by a test double.

const PROBE_ROLE = "probe_role";
const ORG_SETTING = "app.organization_id";

const MIGRATIONS: TenantMigration[] = [
  {
    name: "0001_probe_docs",
    statements: [
      `CREATE TABLE probe_docs (
        id TEXT PRIMARY KEY NOT NULL,
        organization_id TEXT NOT NULL,
        value TEXT NOT NULL
      )`,
      "ALTER TABLE probe_docs ENABLE ROW LEVEL SECURITY",
      `CREATE POLICY probe_isolation ON probe_docs
        USING (organization_id = current_setting('${ORG_SETTING}', true))
        WITH CHECK (organization_id = current_setting('${ORG_SETTING}', true))`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON probe_docs TO ${PROBE_ROLE}`,
    ],
  },
];

// The database handle services receive: a transaction that can run SQL.
type ProbeTx = {
  execute(query: string): Promise<unknown>;
  query<T>(query: string, params?: unknown[]): Promise<T[]>;
};

const pg = new PGlite();

const ledgerExecutor: LedgerExecutor = {
  execute: async (sql) => {
    await pg.exec(sql);
  },
  queryRows: async (sql) => {
    const result = await pg.query<Record<string, unknown>>(sql);
    return result.rows;
  },
};

const store = createRlsPostgresTenantStore<ProbeTx>({
  database: {
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          execute: async (query) => {
            await tx.exec(query);
          },
          query: async <T>(query: string, params?: unknown[]) => {
            const result = await tx.query<T>(query, params);
            return result.rows;
          },
        }),
      ),
  },
  role: PROBE_ROLE,
  organizationIdSetting: ORG_SETTING,
  migrationExecutor: ledgerExecutor,
  migrations: MIGRATIONS,
  // RLS tenant deletion is app-supplied: superuser-scoped purge of the
  // org's rows (the "export/delete my org" path).
  destroyTenant: async (organizationId) => {
    await pg.query("DELETE FROM probe_docs WHERE organization_id = $1", [
      organizationId,
    ]);
  },
});

const checks = tenantIsolationChecks<ProbeTx>({
  store,
  orgA: { id: "org_a", slug: "acme" },
  orgB: { id: "org_b", slug: "globex" },
  writeProbe: async (db, id, value) => {
    // organization_id comes from the transaction's GUC, so the probe writer
    // is org-agnostic — and a WITH CHECK violation would throw.
    await db.query(
      `INSERT INTO probe_docs (id, organization_id, value)
       VALUES ($1, current_setting('${ORG_SETTING}', true), $2)`,
      [id, value],
    );
  },
  readProbes: (db) =>
    db.query<{ id: string; value: string }>(
      "SELECT id, value FROM probe_docs ORDER BY id",
    ),
  supportsDestroy: true,
  supportsMigrate: true,
});

describe("conformance/tenant-isolation on driver-rls-postgres (PGlite, real RLS)", () => {
  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
    // Eager fleet rollout: schema comes from the ledger, not hand-applied DDL.
    const migrated = await store.migrate("org_a");
    if (migrated.isErr()) throw migrated.error;
  });

  for (const check of checks) {
    test(check.name, check.run);
  }
});
