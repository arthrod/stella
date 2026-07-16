import { describe, expect, test } from "bun:test";
import { Result } from "better-result";

import type { TenantStore } from "@stll/tenancy";

import { handleTenantWebhook } from "./dispatch";
import { computeHmacSignature } from "./verify";

const SECRET = "whsec_test_secret";
const PAYLOAD = JSON.stringify({ accountId: "acct_9", event: "completed" });

type FakeDb = { org: string };

const makeStore = () => {
  const withTenantCalls: string[] = [];
  const store: TenantStore<FakeDb> = {
    withTenant: async (organizationId, fn) => {
      withTenantCalls.push(organizationId);
      return await fn({ org: organizationId });
    },
    provision: () => Promise.resolve(Result.ok(undefined)),
    destroy: () => Promise.resolve(Result.ok(undefined)),
    migrate: () => Promise.resolve(Result.ok([])),
  };
  return { store, withTenantCalls };
};

describe("handleTenantWebhook", () => {
  test("verified event reaches the handler under the resolved org with a system actor", async () => {
    const { store, withTenantCalls } = makeStore();
    const signature = await computeHmacSignature({ secret: SECRET, content: PAYLOAD });

    const result = await handleTenantWebhook({
      store,
      source: "docusign-connect",
      verification: { secret: SECRET, payload: PAYLOAD, signature },
      resolveOrganizationId: () => Promise.resolve("org_9"),
      handler: ({ db, actor }) =>
        Promise.resolve({ seenOrg: db.org, actorKind: actor.kind, source: actor.source }),
    });

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) throw result.error;
    expect(result.value).toEqual({
      seenOrg: "org_9",
      actorKind: "system",
      source: "docusign-connect",
    });
    expect(withTenantCalls).toEqual(["org_9"]);
  });

  test("an unverified event NEVER touches the tenant store", async () => {
    const { store, withTenantCalls } = makeStore();
    let resolved = false;

    const result = await handleTenantWebhook({
      store,
      source: "jira",
      verification: { secret: SECRET, payload: PAYLOAD, signature: "forged" },
      resolveOrganizationId: () => {
        resolved = true;
        return Promise.resolve("org_9");
      },
      handler: () => Promise.resolve("unreachable"),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error._tag).toBe("WebhookVerificationError");
    expect(withTenantCalls).toEqual([]);
    // Verify-first: org resolution must not even run on a forged payload.
    expect(resolved).toBe(false);
  });

  test("a verified event with no mapped organization is rejected, not guessed", async () => {
    const { store, withTenantCalls } = makeStore();
    const signature = await computeHmacSignature({ secret: SECRET, content: PAYLOAD });

    const result = await handleTenantWebhook({
      store,
      source: "polar",
      verification: { secret: SECRET, payload: PAYLOAD, signature },
      resolveOrganizationId: () => Promise.resolve(undefined),
      handler: () => Promise.resolve("unreachable"),
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error._tag).toBe("WebhookOrgResolutionError");
    expect(withTenantCalls).toEqual([]);
  });
});
