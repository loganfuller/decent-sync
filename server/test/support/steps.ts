import { type TestContext, beforeEach } from "vitest";

/** The tests that are steps of a scenario, whose tablets the later steps may use (test-scope.ts). */
const steps = new WeakSet<TestContext["task"]>();

/**
 * Makes the tests of the calling `describe` steps of one scenario, each
 * building on what the steps before it left: once one fails, the later ones
 * are skipped rather than failing because of it, so a failure is reported
 * once. The simulated tablets and raw connections a step opens stay open for
 * the later steps, until the file's own afterAll ends them. Call it at the
 * top of the `describe`.
 */
export function runAsSteps(): void {
  let failed = false;
  beforeEach((context) => {
    steps.add(context.task);
    if (failed) context.skip("an earlier step of this scenario failed");
    context.onTestFailed(() => {
      failed = true;
    });
  });
}

/** Whether the test is a step of a scenario (`runAsSteps`). */
export function isStep(task: TestContext["task"]): boolean {
  return steps.has(task);
}
