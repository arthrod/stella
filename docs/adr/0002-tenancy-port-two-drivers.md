# ADR-0002: Tenancy is a port with two drivers; isolation is deployment policy

Status: accepted · Date: 2026-07-11

## Context

Stella isolates tenants with a single Postgres and row-level security (dual pools,
scoped role, per-transaction session GUCs — `apps/api/src/db/scoped.ts`,
`db/rls.ts`), verified by an adversarial test suite. Physical per-tenant isolation
(one database per organization) is the alternative model: stronger isolation
guarantees by construction (no missing-predicate risk, per-tenant backup/restore/
delete/export, per-tenant key material), at higher operational cost. For a product
whose compliance baseline names workspace isolation, least privilege, and data
minimization, physical isolation is a serious option, not a legacy quirk.

Choosing one model globally would either weaken the enterprise isolation story (RLS
only) or abandon the operationally simple default (physical only).

## Decision

1. **`@stll/tenancy` defines a `TenantStore` port**:

   ```ts
   interface TenantStore<TDb> {
     withTenant<T>(organizationId, fn: (db: TDb) => Promise<T>): Promise<T>;
     provision(org): Promise<Result<void, ProvisionError>>;
     destroy(organizationId): Promise<Result<void, DestroyError>>; // GDPR delete/export path
     migrate(organizationId): Promise<Result<AppliedMigration[], MigrateError>>;
   }
   ```

2. **Two drivers, one contract.** `driver-rls-postgres` (this repo's scoped-db
   machinery generalized) and `driver-db-per-org` (registry-resolved database per
   organization). Which driver a deployment uses — even per tenant tier — is
   configuration, not architecture. Stella's default stays RLS; the physical driver
   becomes the enterprise/self-host isolation tier.
3. **Per-tenant migration ledger.** Every tenant database carries its own
   `schema_migrations` ledger; drivers apply pending migrations explicitly
   (first-connection lazily, or eagerly via a fleet runner) and report what they
   applied. Implicit schema "auto-heal" (blind `CREATE TABLE IF NOT EXISTS` on
   connect) is not permitted in kernel drivers: it papers over drift instead of
   tracking it. Semantics match `assertMigrationsApplied()` fail-fast philosophy.
4. **Isolation is proven, not asserted.** The conformance suite runs cross-tenant
   read/write probes against every driver (write as org A, read as org B, expect
   zero rows). A driver that cannot pass the probes does not ship.
5. **Sessionless callers (webhooks) use the same port**: verify the payload
   signature first, resolve `organizationId` from a server-trusted mapping, then
   `withTenant(resolvedOrgId, …)` with a system actor. No bypass path.

## Consequences

- Services never know which isolation model they run on; user-join availability is
  the one legitimate residual difference and stays an explicit context flag.
- "Export my organization" / "delete my organization" have one implementation
  surface (`destroy`) regardless of driver.
- The RLS suite in `tests/security/` generalizes into the conformance kit rather
  than remaining app-local.
