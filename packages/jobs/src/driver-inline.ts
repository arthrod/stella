import { Result } from "better-result";

import { EnqueueError, ScheduleError } from "./port";
import type { JobRunner, TaskRegistry, TaskRunContext } from "./port";

/**
 * The inline driver: runs tasks in-request. Two modes:
 *
 * - **await** (default; dev, tests, minimal self-host): `enqueue` resolves
 *   after the task ran, reporting failure as a Result.
 * - **defer** (Workers): pass `waitUntil` and `enqueue` returns immediately
 *   while the runtime keeps the isolate alive for the running task;
 *   failures go to `onError` (they can no longer reach the caller).
 *
 * No scheduler: `schedule` reports the missing capability honestly. Task
 * definitions registered here run unchanged on the queue/cron drivers.
 */
export type InlineJobRunnerOptions = {
  registry: TaskRegistry;
  /** Max attempts per enqueue (1 = no retry). */
  maxAttempts?: number;
  /** Workers-style lifetime extension; enables defer mode. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Terminal-failure sink for defer mode. */
  onError?: (error: EnqueueError) => void;
  log?: (message: string, context?: Record<string, unknown>) => void;
};

export const createInlineJobRunner = (
  options: InlineJobRunnerOptions,
): JobRunner => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const log = options.log ?? (() => undefined);

  const execute = async (
    taskName: string,
    payload: unknown,
  ): Promise<Result<void, EnqueueError>> => {
    const definition = options.registry.get(taskName);
    if (!definition) {
      return Result.err(
        new EnqueueError({
          message: `Unknown task "${taskName}"`,
          taskName,
        }),
      );
    }

    let parsed: unknown = payload;
    if (definition.parsePayload) {
      try {
        parsed = definition.parsePayload(payload);
      } catch (cause) {
        return Result.err(
          new EnqueueError({
            message: `Invalid payload for task "${taskName}"`,
            taskName,
            cause,
          }),
        );
      }
    }

    let lastCause: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const context: TaskRunContext = { attempt, log };
      try {
        await definition.run(parsed, context);
        return Result.ok(undefined);
      } catch (cause) {
        lastCause = cause;
        log(`task "${taskName}" attempt ${attempt}/${maxAttempts} failed`, {
          taskName,
          attempt,
        });
      }
    }
    return Result.err(
      new EnqueueError({
        message: `Task "${taskName}" failed after ${maxAttempts} attempt(s)`,
        taskName,
        cause: lastCause,
      }),
    );
  };

  return {
    async enqueue(taskName, payload) {
      if (options.waitUntil) {
        const running = execute(taskName, payload).then((result) => {
          if (result.isErr()) options.onError?.(result.error);
        });
        options.waitUntil(running);
        return Result.ok(undefined);
      }
      return await execute(taskName, payload);
    },

    schedule(_cron, taskName) {
      return Promise.resolve(
        Result.err(
          new ScheduleError({
            message:
              "The inline driver has no scheduler; use the queue/cron driver for recurring tasks",
            taskName,
          }),
        ),
      );
    },
  };
};
