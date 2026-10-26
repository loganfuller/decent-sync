import { test } from "@playwright/test";
import type pg from "pg";
import { assertBuilt } from "../../server/test/support/builds.js";
import { assertNoSecretLogged } from "../../server/test/support/secrets.js";
import { type Opened, listenForOpened } from "../../server/test/support/test-scope.js";
import { type TestServer, type TestServerOptions, startTestServer } from "../../server/test/support/test-server.js";

/**
 * Gives the calling spec file its own server on a fresh database, and points
 * `baseURL` at it. Call at the top of the file; its tests share the server
 * and run in order, since each builds on the state the previous one left.
 * The simulated tablets and raw connections a test opens, in its body or a
 * `beforeEach`, end once it has run, whether or not it passed, as Vitest's
 * setup ends them (server/test/support/test-scope.ts), unless it opened them
 * through `keep()`.
 */
export function useFreshServer(options: TestServerOptions = {}): {
  url(): string;
  /** A client of the server's database, for changes no page can make, such as time passing. The caller ends it. */
  connectDatabase(): Promise<pg.Client>;
  /**
   * Calls `open` and keeps what it opens, such as the tablet
   * `SimulatedTablet.load` loads, until the file's tests have all run, for
   * later tests to use. It must open them before it returns.
   */
  keep<T>(open: () => T): T;
} {
  // The server serves the built management interface.
  assertBuilt("web");
  let server: Promise<TestServer> | undefined;
  /** Opened through keep(), ended with the file. */
  const kept: Opened[] = [];
  let keeping = false;

  test.describe.configure({ mode: "serial" });
  // Started by the first test that needs it: Playwright resolves baseURL
  // before beforeAll hooks run. Its start, migrations included, has a timeout
  // of its own, so on a loaded machine it does not use up that test's.
  test.use({ baseURL: [async ({}, use) => use((await (server ??= startTestServer(options))).url), { scope: "test", timeout: 60_000 }] });
  // This runs before any afterAll hook of the file's own, since Playwright 1.63 runs them in declaration order: so
  // what a file keeps ends here, before the server stops, rather than in a hook of its own.
  test.afterAll(async () => {
    // Kept tablets end while the server still answers them.
    await Promise.all(kept.splice(0).map((opened) => opened.end()));
    await (await server)?.stop();
    // No token, link secret or session cookie the server handed out may reach its or a tablet's log. Their logs are
    // kept once they end, so this checks every one the file ran.
    assertNoSecretLogged();
  });

  let url: string | undefined;
  let openedByTest: Opened[] = [];
  let stopListening: (() => void) | undefined;
  // Declared before the file's own beforeEach hooks, so it listens before they run.
  test.beforeEach(async ({ baseURL }) => {
    url = baseURL;
    openedByTest = [];
    stopListening = listenForOpened((opened) => {
      if (!keeping) openedByTest.push(opened);
    });
  });
  // Playwright runs afterEach hooks even when the test, or a hook before them, failed.
  test.afterEach(async () => {
    stopListening?.();
    stopListening = undefined;
    await Promise.all(openedByTest.splice(0).map((opened) => opened.end()));
  });
  return {
    url: () => {
      if (!url) throw new Error("The fresh server is available only inside tests");
      return url;
    },
    connectDatabase: async () => {
      if (!server) throw new Error("The fresh server is available only inside tests");
      return (await server).connectDatabase();
    },
    keep: (open) => {
      const stop = listenForOpened((opened) => kept.push(opened));
      keeping = true;
      try {
        return open();
      } finally {
        keeping = false;
        stop();
      }
    },
  };
}
