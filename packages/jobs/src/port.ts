import { TaggedError } from "better-result";
import type { Result } from "better-result";

/**
 * The async-work port (reconciliation plan R6): "what happens" (a task
 * definition, registered kernel-side) is separated from "when/where it
 * runs" (a driver: BullMQ, Cloudflare Queues, or the inline driver).
 * Deferred work is written once as portable task definitions and upgrades
 * from in-request execution to real queues/cron without rewrites.
 */

export type TaskRunContext = {
  attempt: number;
  log(message: string, context?: Record<string, unknown>): void;
};

export type TaskDefinition<TPayload = unknown> = {
  /** Stable task name, e.g. "workflow.sla-reminder". */
  name: string;
  /** Validate/narrow the payload at the enqueue boundary; throw to reject. */
  parsePayload?(payload: unknown): TPayload;
  run(payload: TPayload, context: TaskRunContext): Promise<void>;
};

export class EnqueueError extends TaggedError("EnqueueError")<{
  message: string;
  taskName: string;
  cause?: unknown;
}>() {}

export class ScheduleError extends TaggedError("ScheduleError")<{
  message: string;
  taskName: string;
}>() {}

export type EnqueueOptions = {
  /** Best-effort delay before execution; drivers may ignore (inline does). */
  delayMs?: number;
};

export interface JobRunner {
  /** Run (or queue) a registered task with a payload. */
  enqueue(
    taskName: string,
    payload: unknown,
    options?: EnqueueOptions,
  ): Promise<Result<void, EnqueueError>>;
  /**
   * Register a recurring run. Drivers without a scheduler (inline) report
   * the missing capability instead of pretending.
   */
  schedule(
    cron: string,
    taskName: string,
    payload?: unknown,
  ): Promise<Result<void, ScheduleError>>;
}

export type TaskRegistry = {
  register<TPayload>(definition: TaskDefinition<TPayload>): void;
  get(name: string): TaskDefinition | undefined;
  names(): string[];
};

export const createTaskRegistry = (): TaskRegistry => {
  const definitions = new Map<string, TaskDefinition>();
  return {
    register(definition) {
      if (definitions.has(definition.name)) {
        throw new Error(`Task "${definition.name}" is already registered`);
      }
      definitions.set(definition.name, definition as TaskDefinition);
    },
    get: (name) => definitions.get(name),
    names: () => [...definitions.keys()],
  };
};
