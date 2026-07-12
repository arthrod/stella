import { describe, test } from "bun:test";

import {
  computeHmacSignature,
  verifyWebhookSignature,
} from "@stll/webhook-kit";

import { webhookSemanticsChecks } from "./webhook-semantics";

// Reference proof: the kernel webhook kit passes the attack matrix.
const checks = webhookSemanticsChecks({
  sign: (payload, timestampMs) =>
    computeHmacSignature({
      secret: "whsec_conformance",
      content: timestampMs === undefined ? payload : `${timestampMs}.${payload}`,
    }),
  verify: async ({ payload, signature, timestampMs, nowMs }) => {
    const result = await verifyWebhookSignature({
      secret: "whsec_conformance",
      payload,
      signature,
      timestampMs,
      now: () => nowMs,
    });
    return result.isOk();
  },
});

describe("conformance/webhook-semantics on @stll/webhook-kit", () => {
  for (const check of checks) {
    test(check.name, check.run);
  }
});
