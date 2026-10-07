import { beforeEach } from "vitest";

/**
 * Makes the tests of the calling `describe` steps of one scenario, each
 * building on what the steps before it left: once one fails, the later ones
 * are skipped rather than failing because of it, so a failure is reported
 * once. Call it at the top of the `describe`.
 */
export function runAsSteps(): void {
  let failed = false;
  beforeEach((context) => {
    if (failed) context.skip("an earlier step of this scenario failed");
    context.onTestFailed(() => {
      failed = true;
    });
  });
}
