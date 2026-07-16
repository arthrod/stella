import { describe, expect, test } from "bun:test";
import { Result } from "better-result";

import { ProvisionError } from "@stll/tenancy";

import {
  createOrganizationProvisioningHook,
  OrganizationProvisioningError,
} from "./provisioning";
import { hasAnyRole, hasOrgOwnerOrAdmin, parseRoles, requireFreshRole } from "./roles";
import { resolveSessionContext } from "./session-context";

describe("role parsing (BA comma-multi-role)", () => {
  test("splits, trims, drops empties", () => {
    expect(parseRoles("admin, sale ,")).toEqual(["admin", "sale"]);
    expect(parseRoles(null)).toEqual([]);
    expect(parseRoles("")).toEqual([]);
  });

  test("multi-role admins pass; members do not", () => {
    expect(hasOrgOwnerOrAdmin("admin,sale")).toBe(true);
    expect(hasOrgOwnerOrAdmin("owner")).toBe(true);
    expect(hasOrgOwnerOrAdmin("member")).toBe(false);
    expect(hasAnyRole("intern", ["owner", "admin", "intern"])).toBe(true);
  });
});

describe("requireFreshRole (fail-closed fresh read)", () => {
  test("passes when the fresh read shows an allowed role", async () => {
    const result = await requireFreshRole({
      userId: "u_1",
      organizationId: "org_1",
      allowed: ["owner", "admin"],
      readMemberRole: () => Promise.resolve("admin,sale"),
    });
    expect(result.isOk()).toBe(true);
  });

  test("denies immediately after revocation, whatever a stale cache says", async () => {
    // The session cache may still say "admin"; the gate only trusts the read.
    const result = await requireFreshRole({
      userId: "u_1",
      organizationId: "org_1",
      allowed: ["owner", "admin"],
      readMemberRole: () => Promise.resolve("member"),
    });
    expect(result.isErr()).toBe(true);
  });

  test("denies when the user has no membership row", async () => {
    const result = await requireFreshRole({
      userId: "u_1",
      organizationId: "org_1",
      allowed: ["owner", "admin"],
      readMemberRole: () => Promise.resolve(undefined),
    });
    expect(result.isErr()).toBe(true);
  });

  test("fails CLOSED when the role read throws", async () => {
    const result = await requireFreshRole({
      userId: "u_1",
      organizationId: "org_1",
      allowed: ["owner", "admin"],
      readMemberRole: () => Promise.reject(new Error("D1 transient blip")),
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error._tag).toBe("PermissionDeniedError");
  });
});

describe("provisioning hook (no orphan orgs)", () => {
  const org = { organization: { id: "org_1", slug: "acme" } };

  test("successful provisioning: no rollback, hook resolves", async () => {
    const rolledBack: string[] = [];
    const hook = createOrganizationProvisioningHook({
      tenantStore: { provision: () => Promise.resolve(Result.ok(undefined)) },
      rollback: (id) => {
        rolledBack.push(id);
        return Promise.resolve();
      },
    });
    await hook(org);
    expect(rolledBack).toEqual([]);
  });

  test("failed provisioning: auth rows rolled back, creation aborts loudly", async () => {
    const rolledBack: string[] = [];
    const hook = createOrganizationProvisioningHook({
      tenantStore: {
        provision: () =>
          Promise.resolve(
            Result.err(
              new ProvisionError({
                message: "turso fork failed",
                organizationId: "org_1",
              }),
            ),
          ),
      },
      rollback: (id) => {
        rolledBack.push(id);
        return Promise.resolve();
      },
    });

    let thrown: unknown;
    try {
      await hook(org);
    } catch (error) {
      thrown = error;
    }
    expect(OrganizationProvisioningError.is(thrown)).toBe(true);
    if (!OrganizationProvisioningError.is(thrown)) throw new Error("expected error");
    expect(thrown.rollback).toBe("clean");
    expect(rolledBack).toEqual(["org_1"]);
  });

  test("rollback failure is reported for manual cleanup, not swallowed", async () => {
    const hook = createOrganizationProvisioningHook({
      tenantStore: {
        provision: () =>
          Promise.resolve(
            Result.err(
              new ProvisionError({
                message: "turso fork failed",
                organizationId: "org_1",
              }),
            ),
          ),
      },
      rollback: () => Promise.reject(new Error("delete failed too")),
    });

    let thrown: unknown;
    try {
      await hook(org);
    } catch (error) {
      thrown = error;
    }
    expect(OrganizationProvisioningError.is(thrown)).toBe(true);
    if (!OrganizationProvisioningError.is(thrown)) throw new Error("expected error");
    expect(thrown.rollback).toBe("failed");
    expect(thrown.message).toContain("cleanup");
  });
});

describe("resolveSessionContext", () => {
  test("resolves the full platform context", () => {
    const resolution = resolveSessionContext({
      user: { id: "u_1", role: "admin" },
      session: { activeOrganizationId: "org_1" },
      member: { role: "owner" },
      activeOrganization: "acme",
    });
    expect(resolution).toEqual({
      ok: true,
      context: {
        userId: "u_1",
        platformRole: "admin",
        activeOrganizationId: "org_1",
        organizationSlug: "acme",
        memberRole: "owner",
      },
    });
  });

  test("distinguishes unauthenticated from no-active-organization", () => {
    expect(resolveSessionContext(null)).toEqual({
      ok: false,
      reason: "unauthenticated",
    });
    expect(
      resolveSessionContext({ user: { id: "u_1" }, session: {} }),
    ).toEqual({ ok: false, reason: "no-active-organization" });
  });
});

describe("createPlatformAuth (shared model factory)", () => {
  test("returns one model id + role vocabulary + wired provisioning hook", async () => {
    const { createPlatformAuth } = await import("./platform-auth");
    const rolledBack: string[] = [];
    const model = createPlatformAuth({
      provisioning: {
        tenantStore: { provision: () => Promise.resolve(Result.ok(undefined)) },
        rollback: (id) => {
          rolledBack.push(id);
          return Promise.resolve();
        },
      },
      productPlugins: [{ name: "polar" }],
    });
    expect(model.modelId).toBe("stll-auth-kit/v1");
    expect(model.roleVocabulary).toContain("owner");
    expect(model.roleVocabulary).toContain("intern");
    expect(model.organizationDefaults.teamsEnabled).toBe(true);
    expect(model.roles.hasOrgOwnerOrAdmin("admin,sale")).toBe(true);
    expect(model.productPlugins).toEqual([{ name: "polar" }]);
    await model.organizationDefaults.afterCreate({
      organization: { id: "org_x", slug: "x" },
    });
    expect(rolledBack).toEqual([]);
  });

  test("provision failure rolls back via the shared afterCreate hook", async () => {
    const { createPlatformAuth } = await import("./platform-auth");
    const rolledBack: string[] = [];
    const model = createPlatformAuth({
      provisioning: {
        tenantStore: {
          provision: () =>
            Promise.resolve(
              Result.err(
                new ProvisionError({
                  message: "fork failed",
                  organizationId: "org_y",
                }),
              ),
            ),
        },
        rollback: (id) => {
          rolledBack.push(id);
          return Promise.resolve();
        },
      },
    });
    await expect(
      model.organizationDefaults.afterCreate({
        organization: { id: "org_y", slug: "y" },
      }),
    ).rejects.toBeInstanceOf(OrganizationProvisioningError);
    expect(rolledBack).toEqual(["org_y"]);
  });
});
