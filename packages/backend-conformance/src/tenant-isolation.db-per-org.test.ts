import { describe, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createDbPerOrgTenantStore } from "@stll/tenancy";
import type {
  LedgerExecutor,
  RegistryEntry,
  TenantConnection,
  TenantMigration,
  TenantRegistry,
} from "@stll/tenancy";

import { tenantIsolationChecks } from "./tenant-isolation";

// Reference proof: the physical-isolation driver (one database per org,
// modelled with bun:sqlite in memory) passes the shared isolation probes.

const MIGRATIONS: TenantMigration[] = [
  {
    name: "0001_probe_docs",
    statements: [
      "CREATE TABLE IF NOT EXISTS probe_docs (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    ],
  },
];

const sqliteExecutor = (db: Database): LedgerExecutor => ({
  execute: (sql) => {
    db.run(sql);
    return Promise.resolve();
  },
  queryRows: (sql) =>
    Promise.resolve(db.query(sql).all() as Record<string, unknown>[]),
});

const databases = new Map<string, Database>();
const registryRows = new Map<string, RegistryEntry>();

const registry: TenantRegistry = {
  get: (organizationId) => Promise.resolve(registryRows.get(organizationId)),
  put: (entry) => {
    registryRows.set(entry.organizationId, entry);
    return Promise.resolve();
  },
  delete: (organizationId) => {
    registryRows.delete(organizationId);
    return Promise.resolve();
  },
};

const store = createDbPerOrgTenantStore<Database>({
  registry,
  openConnection: (entry): Promise<TenantConnection<Database>> => {
    const db = databases.get(entry.organizationId);
    if (!db) throw new Error(`no db for ${entry.organizationId}`);
    return Promise.resolve({ db, executor: sqliteExecutor(db) });
  },
  createDatabase: (org) => {
    databases.set(org.id, new Database(":memory:"));
    return Promise.resolve({
      organizationId: org.id,
      slug: org.slug,
      locator: {},
    });
  },
  dropDatabase: (entry) => {
    databases.get(entry.organizationId)?.close();
    databases.delete(entry.organizationId);
    return Promise.resolve();
  },
  migrations: MIGRATIONS,
});

const checks = tenantIsolationChecks<Database>({
  store,
  orgA: { id: "org_a", slug: "acme" },
  orgB: { id: "org_b", slug: "globex" },
  writeProbe: (db, id, value) => {
    db.query("INSERT INTO probe_docs (id, value) VALUES (?1, ?2)").run(id, value);
    return Promise.resolve();
  },
  readProbes: (db) =>
    Promise.resolve(
      db.query("SELECT id, value FROM probe_docs ORDER BY id").all() as {
        id: string;
        value: string;
      }[],
    ),
  supportsDestroy: true,
  supportsMigrate: true,
});

describe("conformance/tenant-isolation on driver-db-per-org", () => {
  for (const check of checks) {
    test(check.name, check.run);
  }
});
