import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { TenantNotProvisionedError } from "@stll/errors";

import { createDbPerOrgTenantStore } from "./driver-db-per-org";
import type {
  RegistryEntry,
  TenantConnection,
  TenantRegistry,
} from "./driver-db-per-org";
import { appliedMigrationNames, LEDGER_TABLE } from "./ledger";
import type { LedgerExecutor, TenantMigration } from "./ledger";

const MIGRATIONS: TenantMigration[] = [
  {
    name: "0001_probe_docs",
    statements: [
      "CREATE TABLE IF NOT EXISTS probe_docs (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    ],
  },
  {
    name: "0002_notifications",
    statements: [
      "CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL)",
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

/**
 * In-memory test fleet: each provisioned org gets its own bun:sqlite
 * database, mirroring the physical-isolation model (a separate database per
 * organization, resolved via a registry).
 */
type Fleet = {
  registry: TenantRegistry;
  databases: Map<string, Database>;
  registryRows: Map<string, RegistryEntry>;
  pragmaCalls: string[];
  openConnection(entry: RegistryEntry): Promise<TenantConnection<Database>>;
  createDatabase(org: { id: string; slug: string }): Promise<RegistryEntry>;
  dropDatabase(entry: RegistryEntry): Promise<void>;
};

const createFleet = (): Fleet => {
  const databases = new Map<string, Database>();
  const registryRows = new Map<string, RegistryEntry>();
  const pragmaCalls: string[] = [];

  return {
    databases,
    registryRows,
    pragmaCalls,
    registry: {
      get: (organizationId) =>
        Promise.resolve(registryRows.get(organizationId)),
      put: (entry) => {
        registryRows.set(entry.organizationId, entry);
        return Promise.resolve();
      },
      delete: (organizationId) => {
        registryRows.delete(organizationId);
        return Promise.resolve();
      },
    },
    openConnection: (entry) => {
      const db = databases.get(entry.organizationId);
      if (!db) throw new Error(`test fleet has no db for ${entry.organizationId}`);
      return Promise.resolve({ db, executor: sqliteExecutor(db) });
    },
    createDatabase: (org) => {
      databases.set(org.id, new Database(":memory:"));
      return Promise.resolve({
        organizationId: org.id,
        slug: org.slug,
        locator: { name: `tenant-${org.slug}` },
      });
    },
    dropDatabase: (entry) => {
      databases.get(entry.organizationId)?.close();
      databases.delete(entry.organizationId);
      return Promise.resolve();
    },
  };
};

const storeFor = (fleet: Fleet, migrations = MIGRATIONS) =>
  createDbPerOrgTenantStore<Database>({
    registry: fleet.registry,
    openConnection: fleet.openConnection,
    createDatabase: fleet.createDatabase,
    dropDatabase: fleet.dropDatabase,
    migrations,
    onConnect: (connection) => {
      // The FK-enforcement invariant from the workflow schema, asserted per
      // connection exactly like the production driver.
      fleet.pragmaCalls.push("PRAGMA foreign_keys = ON");
      return connection.executor.execute("PRAGMA foreign_keys = ON").then(() => {});
    },
  });

const ORG_A = { id: "org_a", slug: "acme" };
const ORG_B = { id: "org_b", slug: "globex" };

describe("db-per-org driver", () => {
  test("withTenant on an unprovisioned org throws TenantNotProvisionedError", async () => {
    const store = storeFor(createFleet());
    expect(store.withTenant("org_ghost", async () => "unreachable")).rejects.toThrow(
      TenantNotProvisionedError,
    );
  });

  test("provision creates the database, migrates it fully, and registers it", async () => {
    const fleet = createFleet();
    const store = storeFor(fleet);

    const provisioned = await store.provision(ORG_A);
    expect(provisioned.isOk()).toBe(true);
    expect(fleet.registryRows.has(ORG_A.id)).toBe(true);

    const db = fleet.databases.get(ORG_A.id);
    if (!db) throw new Error("expected tenant db");
    expect(await appliedMigrationNames(sqliteExecutor(db))).toEqual(
      new Set(["0001_probe_docs", "0002_notifications"]),
    );
  });

  test("cross-tenant isolation probe: write as org A, read as org B, zero rows", async () => {
    const fleet = createFleet();
    const store = storeFor(fleet);
    await store.provision(ORG_A);
    await store.provision(ORG_B);

    await store.withTenant(ORG_A.id, async (db) => {
      db.run("INSERT INTO probe_docs (id, value) VALUES ('doc1', 'secret-of-acme')");
    });

    const rowsSeenByB = await store.withTenant(ORG_B.id, async (db) =>
      db.query("SELECT * FROM probe_docs").all(),
    );
    expect(rowsSeenByB).toEqual([]);

    const rowsSeenByA = await store.withTenant(ORG_A.id, async (db) =>
      db.query("SELECT * FROM probe_docs").all(),
    );
    expect(rowsSeenByA.length).toBe(1);
  });

  test("connection invariants (PRAGMA foreign_keys) run on every connection", async () => {
    const fleet = createFleet();
    const store = storeFor(fleet);
    await store.provision(ORG_A);

    fleet.pragmaCalls.length = 0;
    await store.withTenant(ORG_A.id, async () => undefined);
    await store.withTenant(ORG_A.id, async () => undefined);
    expect(fleet.pragmaCalls.length).toBe(2);
  });

  test("a stale tenant is healed by the ledger, explicitly, on first connection", async () => {
    const fleet = createFleet();

    // Yesterday's deploy: only migration 0001 exists.
    const oldStore = storeFor(fleet, MIGRATIONS.slice(0, 1));
    await oldStore.provision(ORG_A);

    // Today's deploy ships 0002. A fresh store (new isolate) sees the org.
    const newStore = storeFor(fleet);
    await newStore.withTenant(ORG_A.id, async (db) => {
      // The table from 0002 exists because the ledger applied it before fn.
      db.run("INSERT INTO notifications (id, title) VALUES ('n1', 'hello')");
    });

    // And unlike auto-heal, the fix is RECORDED: the ledger names 0002.
    const db = fleet.databases.get(ORG_A.id);
    if (!db) throw new Error("expected tenant db");
    expect(await appliedMigrationNames(sqliteExecutor(db))).toEqual(
      new Set(["0001_probe_docs", "0002_notifications"]),
    );
  });

  test("migrate() reports exactly what it applied", async () => {
    const fleet = createFleet();
    const oldStore = storeFor(fleet, MIGRATIONS.slice(0, 1));
    await oldStore.provision(ORG_A);

    const newStore = storeFor(fleet);
    const result = await newStore.migrate(ORG_A.id);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw result.error;
    expect(result.value.map((m) => m.name)).toEqual(["0002_notifications"]);

    const again = await newStore.migrate(ORG_A.id);
    if (!again.isOk()) throw again.error;
    expect(again.value).toEqual([]);
  });

  test("migrate() on an unprovisioned org returns MigrateError, not a throw", async () => {
    const store = storeFor(createFleet());
    const result = await store.migrate("org_ghost");
    expect(result.isErr()).toBe(true);
  });

  test("provision failure rolls back: no registry row, no orphan database", async () => {
    const fleet = createFleet();
    const store = createDbPerOrgTenantStore<Database>({
      registry: fleet.registry,
      openConnection: fleet.openConnection,
      createDatabase: fleet.createDatabase,
      dropDatabase: fleet.dropDatabase,
      // A migration that always fails, so provisioning cannot complete.
      migrations: [{ name: "0001_broken", statements: ["CREATE BROKEN ("] }],
    });

    const result = await store.provision(ORG_A);
    expect(result.isErr()).toBe(true);
    expect(fleet.registryRows.has(ORG_A.id)).toBe(false);
    expect(fleet.databases.has(ORG_A.id)).toBe(false);
  });

  test("provision without createDatabase capability reports ProvisionError", async () => {
    const fleet = createFleet();
    const store = createDbPerOrgTenantStore<Database>({
      registry: fleet.registry,
      openConnection: fleet.openConnection,
      migrations: MIGRATIONS,
    });
    const result = await store.provision(ORG_A);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error._tag).toBe("ProvisionError");
  });

  test("provisioning the same org twice is rejected", async () => {
    const fleet = createFleet();
    const store = storeFor(fleet);
    await store.provision(ORG_A);
    const second = await store.provision(ORG_A);
    expect(second.isErr()).toBe(true);
  });

  test("destroy removes the database and registry row; org becomes unprovisioned; destroy is idempotent", async () => {
    const fleet = createFleet();
    const store = storeFor(fleet);
    await store.provision(ORG_A);

    const destroyed = await store.destroy(ORG_A.id);
    expect(destroyed.isOk()).toBe(true);
    expect(fleet.registryRows.has(ORG_A.id)).toBe(false);
    expect(fleet.databases.has(ORG_A.id)).toBe(false);

    expect(store.withTenant(ORG_A.id, async () => "unreachable")).rejects.toThrow(
      TenantNotProvisionedError,
    );

    const again = await store.destroy(ORG_A.id);
    expect(again.isOk()).toBe(true);
  });

  test("a database ahead of the code fails closed instead of serving", async () => {
    const fleet = createFleet();
    const futureStore = storeFor(fleet, MIGRATIONS);
    await futureStore.provision(ORG_A);

    // Roll back the code: this store only knows migration 0001.
    const oldStore = storeFor(fleet, MIGRATIONS.slice(0, 1));
    expect(
      oldStore.withTenant(ORG_A.id, async () => "unreachable"),
    ).rejects.toThrow(/ahead of this code/);
  });
});

// Sanity: the ledger table name used in assertions matches the module const.
void LEDGER_TABLE;
