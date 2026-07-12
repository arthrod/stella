import { violation } from "./checks";
import type { ConformanceCheck } from "./checks";

/**
 * Webhook-semantics conformance (suite 3): the tampered/replayed/forged
 * payload matrix any webhook endpoint must reject. The adapter wraps the
 * product's actual sign/verify path; the suite owns the attack matrix.
 */
export type WebhookSemanticsAdapter = {
  /** Sign a payload the way the product's provider config would. */
  sign(payload: string, timestampMs?: number): Promise<string>;
  /** Run the product's verification; resolve true when the event is accepted. */
  verify(args: {
    payload: string;
    signature: string;
    timestampMs?: number;
    nowMs: number;
  }): Promise<boolean>;
  /** Replay window the deployment enforces (ms). Default: 5 minutes. */
  replayWindowMs?: number;
};

const BASE_NOW = 1_770_000_000_000;
const PAYLOAD = JSON.stringify({ event: "conformance-probe", id: "evt_1" });

export const webhookSemanticsChecks = (
  adapter: WebhookSemanticsAdapter,
): ConformanceCheck[] => {
  const windowMs = adapter.replayWindowMs ?? 5 * 60 * 1000;

  return [
    {
      name: "webhooks: a correctly signed, fresh event is accepted",
      run: async () => {
        const signature = await adapter.sign(PAYLOAD, BASE_NOW);
        const accepted = await adapter.verify({
          payload: PAYLOAD,
          signature,
          timestampMs: BASE_NOW,
          nowMs: BASE_NOW + 1000,
        });
        if (!accepted) violation("a valid event was rejected");
      },
    },
    {
      name: "webhooks: a tampered payload is rejected",
      run: async () => {
        const signature = await adapter.sign(PAYLOAD, BASE_NOW);
        const accepted = await adapter.verify({
          payload: PAYLOAD.replace("evt_1", "evt_2"),
          signature,
          timestampMs: BASE_NOW,
          nowMs: BASE_NOW + 1000,
        });
        if (accepted) violation("tampered payload was accepted");
      },
    },
    {
      name: "webhooks: a corrupted signature is rejected (single-char flip)",
      run: async () => {
        const signature = await adapter.sign(PAYLOAD, BASE_NOW);
        const flipped =
          (signature[0] === "a" ? "b" : "a") + signature.slice(1);
        const accepted = await adapter.verify({
          payload: PAYLOAD,
          signature: flipped,
          timestampMs: BASE_NOW,
          nowMs: BASE_NOW + 1000,
        });
        if (accepted) violation("corrupted signature was accepted");
      },
    },
    {
      name: "webhooks: a truncated signature is rejected",
      run: async () => {
        const signature = await adapter.sign(PAYLOAD, BASE_NOW);
        const accepted = await adapter.verify({
          payload: PAYLOAD,
          signature: signature.slice(0, Math.floor(signature.length / 2)),
          timestampMs: BASE_NOW,
          nowMs: BASE_NOW + 1000,
        });
        if (accepted) violation("truncated signature was accepted");
      },
    },
    {
      name: "webhooks: an empty signature is rejected",
      run: async () => {
        const accepted = await adapter.verify({
          payload: PAYLOAD,
          signature: "",
          timestampMs: BASE_NOW,
          nowMs: BASE_NOW + 1000,
        });
        if (accepted) violation("empty signature was accepted");
      },
    },
    {
      name: "webhooks: a replayed (stale) event is rejected beyond the window",
      run: async () => {
        const staleTs = BASE_NOW - windowMs - 60_000;
        const signature = await adapter.sign(PAYLOAD, staleTs);
        const accepted = await adapter.verify({
          payload: PAYLOAD,
          signature,
          timestampMs: staleTs,
          nowMs: BASE_NOW,
        });
        if (accepted) violation("stale (replayed) event was accepted");
      },
    },
    {
      name: "webhooks: a future-dated event beyond the window is rejected",
      run: async () => {
        const futureTs = BASE_NOW + windowMs + 60_000;
        const signature = await adapter.sign(PAYLOAD, futureTs);
        const accepted = await adapter.verify({
          payload: PAYLOAD,
          signature,
          timestampMs: futureTs,
          nowMs: BASE_NOW,
        });
        if (accepted) violation("future-dated event was accepted");
      },
    },
  ];
};
