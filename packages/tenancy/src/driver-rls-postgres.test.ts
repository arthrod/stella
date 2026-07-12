import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createRlsPostgresTenantStore } from "./driver-rls-postgres";
import type { LedgerExecutor } from "./ledger";

type FakeTx = {
  execute(query: string): Promise<unknown>;
  executed: string[];
};

const createFakeDatabase = () => {
  const transactions: FakeTx[] = [];
  return {
    transactions,
    database: {
      transaction: async <T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> => {
        const executed: string[] = [];
        const tx: FakeTx = {
          executed,
          execute: (query: string) => {
            executed.push(query);
            return Promise.resolve([]);
          },
        };
        transactions.push(tx);
        return await fn(tx);
      },
    },
  };
};

describe("rls-postgres driver", () => {
  test("withTenant scopes the transaction: restricted role + organization GUC, then fn", async () => {
    const fake = createFakeDatabase();
    const store = createRlsPostgresTenantStore({
      database: fake.database,
      role: "stella",
      organizationIdSetting: "app.organization_id",
    });

    const value = await store.withTenant("org_123", async (tx) => {
      await tx.execute("SELECT * FROM matters");
      return "done";
    });

    expect(value).toBe("done");
    const [tx] = fake.transactions;
    if (!tx) throw new Error("expected a transaction");
    expect(tx.executed[0]).toContain("set_config('role', 'stella', true)");
    expect(tx.executed[0]).toContain(
      "set_config('app.organization_id', 'org_123', true)",
    );
    // Scope is set before any service SQL runs.
    expect(tx.executed[1]).toBe("SELECT * FROM matters");
  });

  test("extendScope runs after the base scope inside the same transaction", async () => {
    const fake = createFakeDatabase();
    const store = createRlsPostgresTenantStore({
      database: fake.database,
      role: "stella",
      organizationIdSetting: "app.organization_id",
      extendScope: async (tx, organizationId) => {
        await tx.execute(`-- extra scope for ${organizationId}`);
      },
    });

    await store.withTenant("org_123", async () => undefined);
    const [tx] = fake.transactions;
    if (!tx) throw new Error("expected a transaction");
    expect(tx.executed[1]).toBe("-- extra scope for org_123");
  });

  test("rejects organization ids outside the safe alphabet (they reach SQL literals)", async () => {
    const fake = createFakeDatabase();
    const store = createRlsPostgresTenantStore({
      database: fake.database,
      role: "stella",
      organizationIdSetting: "app.organization_id",
    });

    expect(
      store.withTenant("org'; SELECT pg_sleep(10);--", async () => undefined),
    ).rejects.toThrow(/Invalid organization id/);
    expect(fake.transactions).toEqual([]);
  });

  test("rejects unsafe role/setting identifiers at construction", () => {
    const fake = createFakeDatabase();
    expect(() =>
      createRlsPostgresTenantStore({
        database: fake.database,
        role: "stella'; DROP ROLE postgres;--",
        organizationIdSetting: "app.organization_id",
      }),
    ).toThrow(/Invalid role identifier/);
    expect(() =>
      createRlsPostgresTenantStore({
        database: fake.database,
        role: "stella",
        organizationIdSetting: "app.organization id",
      }),
    ).toThrow(/Invalid setting identifier/);
  });

  test("provision is a no-op ok; destroy without capability reports DestroyError", async () => {
    const fake = createFakeDatabase();
    const store = createRlsPostgresTenantStore({
      database: fake.database,
      role: "stella",
      organizationIdSetting: "app.organization_id",
    });

    const provisioned = await store.provision({ id: "org_123", slug: "acme" });
    expect(provisioned.isOk()).toBe(true);

    const destroyed = await store.destroy("org_123");
    expect(destroyed.isErr()).toBe(true);
    if (!destroyed.isErr()) throw new Error("expected err");
    expect(destroyed.error._tag).toBe("DestroyError");
  });

  test("destroy delegates to the app-supplied destroyTenant", async () => {
    const fake = createFakeDatabase();
    const destroyedOrgs: string[] = [];
    const store = createRlsPostgresTenantStore({
      database: fake.database,
      role: "stella",
      organizationIdSetting: "app.organization_id",
      destroyTenant: (organizationId) => {
        destroyedOrgs.push(organizationId);
        return Promise.resolve();
      },
    });

    const destroyed = await store.destroy("org_123");
    expect(destroyed.isOk()).toBe(true);
    expect(destroyedOrgs).toEqual(["org_123"]);
  });

  test("migrate runs the shared-schema ledger (same semantics as the physical driver)", async () => {
    const fake = createFakeDatabase();
    const shared = new Database(":memory:");
    const executor: LedgerExecutor = {
      execute: (sql) => {
        shared.run(sql);
        return Promise.resolve();
      },
      queryRows: (sql) =>
        Promise.resolve(shared.query(sql).all() as Record<string, unknown>[]),
    };
    const store = createRlsPostgresTenantStore({
      database: fake.database,
      role: "stella",
      organizationIdSetting: "app.organization_id",
      migrationExecutor: executor,
      migrations: [
        {
          name: "0001_probe",
          statements: ["CREATE TABLE probe (id TEXT PRIMARY KEY)"],
        },
      ],
    });

    const result = await store.migrate("org_123");
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw result.error;
    expect(result.value.map((m) => m.name)).toEqual(["0001_probe"]);
  });

  test("migrate without a configured executor reports MigrateError", async () => {
    const fake = createFakeDatabase();
    const store = createRlsPostgresTenantStore({
      database: fake.database,
      role: "stella",
      organizationIdSetting: "app.organization_id",
    });
    const result = await store.migrate("org_123");
    expect(result.isErr()).toBe(true);
  });
});
