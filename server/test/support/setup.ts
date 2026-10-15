import { afterAll, afterEach, beforeEach } from "vitest";
import { assertNoSecretLogged } from "./secrets.js";
import { isStep } from "./steps.js";
import { type Opened, listenForOpened } from "./test-scope.js";

// Runs before every Vitest test file (vitest.config.ts). Registered first,
// these hooks run before the file's own beforeEach hooks, and after its own
// afterEach and afterAll hooks.

// Ends the simulated tablets and raw connections each test opened, in its
// body or its beforeEach hooks, once it and its afterEach hooks have run,
// unless it is a step of a scenario (test-scope.ts). Those opened in a
// beforeAll hook are the file's, ended by its afterAll.
let openedByTest: Opened[] = [];
let stopListening: (() => void) | undefined;
beforeEach(() => {
  openedByTest = [];
  stopListening = listenForOpened((opened) => openedByTest.push(opened));
});
afterEach(async (context) => {
  stopListening?.();
  stopListening = undefined;
  const ending = openedByTest.splice(0);
  if (!isStep(context.task)) await Promise.all(ending.map((opened) => opened.end()));
});

// Its log is kept once a server or simulated tablet stops, so this checks every one the file ran.
afterAll(() => assertNoSecretLogged());
