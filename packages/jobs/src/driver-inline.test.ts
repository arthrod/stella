import { describe, expect, test } from "bun:test";

import { createInlineJobRunner } from "./driver-inline";
import { createTaskRegistry } from "./port";
import type { TaskDefinition } from "./port";

const makeRegistry = () => {
  const registry = createTaskRegistry();
  const runs: { payload: unknown; attempt: number }[] = [];
  const record: TaskDefinition<{ workflowId: string }> = {
    name: "workflow.sla-reminder",
    parsePayload: (payload) => {
      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof (payload as { workflowId?: unknown }).workflowId !== "string"
      ) {
        throw new Error("workflowId required");
      }
      return payload as { workflowId: string };
    },
    run: (payload, context) => {
      runs.push({ payload, attempt: context.attempt });
      return Promise.resolve();
    },
  };
  registry.register(record);
  return { registry, runs };
};

describe("task registry", () => {
  test("rejects duplicate task names", () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.register({
        name: "workflow.sla-reminder",
        run: () => Promise.resolve(),
      }),
    ).toThrow(/already registered/);
    expect(registry.names()).toEqual(["workflow.sla-reminder"]);
  });
});

describe("inline driver (await mode)", () => {
  test("runs the task synchronously with a validated payload", async () => {
    const { registry, runs } = makeRegistry();
    const runner = createInlineJobRunner({ registry });

    const result = await runner.enqueue("workflow.sla-reminder", {
      workflowId: "wf_1",
    });
    expect(result.isOk()).toBe(true);
    expect(runs).toEqual([{ payload: { workflowId: "wf_1" }, attempt: 1 }]);
  });

  test("rejects an invalid payload at the boundary without running", async () => {
    const { registry, runs } = makeRegistry();
    const runner = createInlineJobRunner({ registry });

    const result = await runner.enqueue("workflow.sla-reminder", { nope: 1 });
    expect(result.isErr()).toBe(true);
    expect(runs).toEqual([]);
  });

  test("unknown task name → EnqueueError", async () => {
    const { registry } = makeRegistry();
    const runner = createInlineJobRunner({ registry });
    const result = await runner.enqueue("no.such.task", {});
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error.taskName).toBe("no.such.task");
  });

  test("retries up to maxAttempts, then reports the final failure with cause", async () => {
    const registry = createTaskRegistry();
    let attempts = 0;
    registry.register({
      name: "flaky",
      run: () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error(`boom ${attempts}`));
        return Promise.resolve();
      },
    });
    const runner = createInlineJobRunner({ registry, maxAttempts: 3 });

    const ok = await runner.enqueue("flaky", {});
    expect(ok.isOk()).toBe(true);
    expect(attempts).toBe(3);

    attempts = -10; // now it fails all 3 attempts (attempts stays < 3)
    const failed = await runner.enqueue("flaky", {});
    expect(failed.isErr()).toBe(true);
    if (!failed.isErr()) throw new Error("expected err");
    expect(failed.error.message).toContain("after 3 attempt(s)");
    expect(String(failed.error.cause)).toContain("boom");
  });
});

describe("inline driver (defer mode, Workers waitUntil)", () => {
  test("returns immediately, keeps the isolate alive, reports failure to onError", async () => {
    const registry = createTaskRegistry();
    let resolveTask: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    let ran = false;
    registry.register({
      name: "slow",
      run: async () => {
        await gate;
        ran = true;
        throw new Error("late failure");
      },
    });

    const kept: Promise<unknown>[] = [];
    const errors: string[] = [];
    const runner = createInlineJobRunner({
      registry,
      waitUntil: (promise) => kept.push(promise),
      onError: (error) => errors.push(error.message),
    });

    const result = await runner.enqueue("slow", {});
    // Caller got its answer before the task even ran.
    expect(result.isOk()).toBe(true);
    expect(ran).toBe(false);
    expect(kept.length).toBe(1);

    resolveTask();
    await kept[0];
    expect(ran).toBe(true);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('"slow" failed');
  });
});

describe("inline driver capabilities", () => {
  test("schedule reports the missing scheduler instead of pretending", async () => {
    const { registry } = makeRegistry();
    const runner = createInlineJobRunner({ registry });
    const result = await runner.schedule("0 9 * * *", "workflow.sla-reminder");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) throw new Error("expected err");
    expect(result.error._tag).toBe("ScheduleError");
  });
});
