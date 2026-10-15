import { afterAll, beforeEach } from "vitest";
import { assertNoSecretLogged } from "./secrets.js";
import { isStep } from "./steps.js";
import { type Opened, listenForOpened } from "./test-scope.js";

// Runs before every Vitest test file (vitest.config.ts). Registered first,
// these hooks run before the file's own beforeEach hooks, and after its own
// afterAll hooks.

// Ends the simulated tablets and raw connections each test opened, in its
// body or its beforeEach hooks, once it and its afterEach hooks have run,
// even if one of them failed, unless it is a step of a scenario
// (test-scope.ts). Those opened in a beforeAll hook are the file's, ended by
// its afterAll. Vitest skips the rest of a test's afterEach hooks once one
// fails, so this is the test's finish, which Vitest runs whatever happened.
beforeEach((context) => {
  const openedByTest: Opened[] = [];
  const stopListening = listenForOpened((opened) => openedByTest.push(opened));
  context.onTestFinished(async () => {
    stopListening();
    if (!isStep(context.task)) await Promise.all(openedByTest.map((opened) => opened.end()));
  });
});

// Its log is kept once a server or simulated tablet stops, so this checks every one the file ran.
afterAll(() => assertNoSecretLogged());
