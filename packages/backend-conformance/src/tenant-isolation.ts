import type { OrganizationRef, TenantStore } from "@stll/tenancy";

import { violation } from "./checks";
import type { ConformanceCheck } from "./checks";

/**
 * Tenant-isolation probes (conformance suite 1): the adversarial checks any
 * `TenantStore` driver must pass before it ships — write as org A, read as
 * org B, expect nothing. Generalized from the app-level RLS security suite
 * so both isolation models are held to the same bar.
 *
 * The adapter supplies the driver plus primitive probe accessors; the suite
 * owns the scenarios and assertions.
 */
export type TenantIsolationAdapter<TDb> = {
  store: TenantStore<TDb>;
  orgA: OrganizationRef;
  orgB: OrganizationRef;
  /** An organization id guaranteed never to be provisioned. */
  ghostOrganizationId?: string;
  /** Insert one probe row visible to the current tenant only. */
  writeProbe(db: TDb, id: string, value: string): Promise<void>;
  /** Read every probe row visible to the current tenant. */
  readProbes(db: TDb): Promise<readonly { id: string; value: string }[]>;
  /**
   * Set false when the store under test has no provision capability (the
   * adapter must then pre-provision orgA/orgB itself).
   */
  provisionInSuite?: boolean;
  /** Set true when the store supports destroy (adds revocation checks). */
  supportsDestroy?: boolean;
  /** Set true when the store supports migrate (adds idempotency check). */
  supportsMigrate?: boolean;
};

const isTenantNotProvisioned = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { _tag?: unknown })._tag === "TenantNotProvisionedError";

export const tenantIsolationChecks = <TDb>(
  adapter: TenantIsolationAdapter<TDb>,
): ConformanceCheck[] => {
  const { store, orgA, orgB } = adapter;
  const ghostId = adapter.ghostOrganizationId ?? "org_conformance_ghost";
  const probeId = `probe_${orgA.id}`;
  const checks: ConformanceCheck[] = [];

  if (adapter.provisionInSuite !== false) {
    checks.push({
      name: "tenancy: provisioning org A and org B succeeds",
      run: async () => {
        for (const org of [orgA, orgB]) {
          const result = await store.provision(org);
          if (result.isErr()) {
            violation(`provision(${org.id}) failed: ${result.error.message}`);
          }
        }
      },
    });
  }

  checks.push(
    {
      name: "tenancy: org A sees its own probe row",
      run: async () => {
        await store.withTenant(orgA.id, async (db) => {
          await adapter.writeProbe(db, probeId, `secret-of-${orgA.slug}`);
        });
        const rows = await store.withTenant(orgA.id, (db) =>
          adapter.readProbes(db),
        );
        if (!rows.some((row) => row.id === probeId)) {
          violation("org A cannot read back the row it just wrote");
        }
      },
    },
    {
      name: "tenancy: org B cannot read org A's rows (cross-tenant probe)",
      run: async () => {
        const rows = await store.withTenant(orgB.id, (db) =>
          adapter.readProbes(db),
        );
        const leaked = rows.filter((row) => row.id === probeId);
        if (leaked.length > 0) {
          violation(
            `cross-tenant leak: org B read ${leaked.length} row(s) written by org A`,
          );
        }
      },
    },
    {
      name: "tenancy: org B's writes do not shadow or clobber org A's rows",
      run: async () => {
        await store.withTenant(orgB.id, async (db) => {
          await adapter.writeProbe(db, `probe_${orgB.id}`, `secret-of-${orgB.slug}`);
        });
        const rowsA = await store.withTenant(orgA.id, (db) =>
          adapter.readProbes(db),
        );
        if (rowsA.some((row) => row.id === `probe_${orgB.id}`)) {
          violation("org A can see org B's probe row");
        }
        const own = rowsA.find((row) => row.id === probeId);
        if (own?.value !== `secret-of-${orgA.slug}`) {
          violation("org A's row was altered by activity in org B");
        }
      },
    },
    {
      name: "tenancy: an unknown organization can never see tenant data",
      run: async () => {
        let rows: readonly { id: string; value: string }[];
        try {
          rows = await store.withTenant(ghostId, (db) =>
            adapter.readProbes(db),
          );
        } catch (error) {
          if (isTenantNotProvisioned(error)) return; // physical model: fail closed
          throw error;
        }
        // RLS model: the call succeeds but must be scoped to nothing.
        if (rows.length > 0) {
          violation(
            `unprovisioned org '${ghostId}' can read ${rows.length} tenant row(s)`,
          );
        }
      },
    },
  );

  if (adapter.supportsMigrate) {
    checks.push({
      name: "tenancy: migrate is explicit and idempotent (ledger, not auto-heal)",
      run: async () => {
        const first = await store.migrate(orgA.id);
        if (first.isErr()) {
          violation(`migrate(${orgA.id}) failed: ${first.error.message}`);
          return;
        }
        const second = await store.migrate(orgA.id);
        if (second.isErr()) {
          violation(`second migrate(${orgA.id}) failed: ${second.error.message}`);
          return;
        }
        if (second.value.length !== 0) {
          violation(
            `migrate is not idempotent: second run applied ${second.value.length} migration(s)`,
          );
        }
      },
    });
  }

  if (adapter.supportsDestroy) {
    checks.push({
      name: "tenancy: destroy revokes access and is idempotent (GDPR delete)",
      run: async () => {
        const destroyed = await store.destroy(orgB.id);
        if (destroyed.isErr()) {
          violation(`destroy(${orgB.id}) failed: ${destroyed.error.message}`);
        }
        try {
          const rows = await store.withTenant(orgB.id, (db) =>
            adapter.readProbes(db),
          );
          if (rows.length > 0) {
            violation("destroyed org can still read tenant rows");
          }
        } catch (error) {
          if (!isTenantNotProvisioned(error)) throw error;
        }
        const again = await store.destroy(orgB.id);
        if (again.isErr()) {
          violation("destroy is not idempotent");
        }
      },
    });
  }

  return checks;
};
