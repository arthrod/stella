import { TaggedError } from "better-result";

/**
 * A conformance check: a named assertion any driver/shell must pass. Checks
 * are runner-agnostic — mount them in whatever test framework the consumer
 * uses (`for (const check of checks) test(check.name, check.run)`), or run
 * them all with `runConformance` in a script.
 */
export type ConformanceCheck = {
  name: string;
  run(): Promise<void>;
};

export class ConformanceViolation extends TaggedError("ConformanceViolation")<{
  message: string;
  check?: string;
}>() {}

export const violation = (message: string): never => {
  throw new ConformanceViolation({ message });
};

export type ConformanceReport = {
  passed: string[];
  failed: { name: string; error: unknown }[];
};

export const runConformance = async (
  checks: readonly ConformanceCheck[],
): Promise<ConformanceReport> => {
  const report: ConformanceReport = { passed: [], failed: [] };
  for (const check of checks) {
    try {
      await check.run();
      report.passed.push(check.name);
    } catch (error) {
      report.failed.push({ name: check.name, error });
    }
  }
  return report;
};

/** Run every check and throw a single aggregate error if any failed. */
export const assertConformance = async (
  checks: readonly ConformanceCheck[],
): Promise<void> => {
  const report = await runConformance(checks);
  if (report.failed.length === 0) return;
  const lines = report.failed.map(
    (failure) => `  ✗ ${failure.name}: ${String(failure.error)}`,
  );
  throw new ConformanceViolation({
    message: `${report.failed.length} conformance check(s) failed:\n${lines.join("\n")}`,
  });
};
