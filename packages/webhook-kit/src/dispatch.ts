import { Result, TaggedError } from "better-result";

import type { OrganizationId, TenantStore } from "@stll/tenancy";

import { verifyWebhookSignature, WebhookVerificationError } from "./verify";
import type { VerifyWebhookOptions } from "./verify";

/**
 * The sessionless-caller pattern (plan R1/R6): verify the signature FIRST,
 * resolve the organization from a server-trusted mapping (never from the
 * payload alone), then enter tenant data through the same `TenantStore`
 * port every authenticated request uses — with an explicit system actor.
 * There is no bypass path for webhooks under either isolation model.
 */

export class WebhookOrgResolutionError extends TaggedError(
  "WebhookOrgResolutionError",
)<{
  message: string;
}>() {}

export type SystemActor = {
  kind: "system";
  /** Which integration is acting, e.g. "docusign-connect". */
  source: string;
};

export type TenantWebhookOptions<TDb, TResult> = {
  store: TenantStore<TDb>;
  /** e.g. "docusign-connect", "jira", "polar" — recorded on the actor. */
  source: string;
  verification: VerifyWebhookOptions;
  /**
   * Server-trusted mapping from the (verified) payload to an organization —
   * e.g. a lookup in the integrations registry keyed by account id. Return
   * undefined when no organization claims the event.
   */
  resolveOrganizationId(): Promise<OrganizationId | undefined>;
  handler(context: { db: TDb; actor: SystemActor }): Promise<TResult>;
};

export type TenantWebhookError =
  | WebhookVerificationError
  | WebhookOrgResolutionError;

export const handleTenantWebhook = async <TDb, TResult>(
  options: TenantWebhookOptions<TDb, TResult>,
): Promise<Result<TResult, TenantWebhookError>> => {
  const verified = await verifyWebhookSignature(options.verification);
  if (verified.isErr()) {
    return Result.err(verified.error);
  }

  const organizationId = await options.resolveOrganizationId();
  if (!organizationId) {
    return Result.err(
      new WebhookOrgResolutionError({
        message: `No organization mapped for ${options.source} webhook`,
      }),
    );
  }

  const value = await options.store.withTenant(organizationId, (db) =>
    options.handler({ db, actor: { kind: "system", source: options.source } }),
  );
  return Result.ok(value);
};
