import { test } from "@playwright/test";
import type pg from "pg";
import { assertBuilt } from "../../server/test/support/builds.js";
import { type TestServer, type TestServerOptions, startTestServer } from "../../server/test/support/test-server.js";

/**
 * Gives the calling spec file its own server on a fresh database, and points
 * `baseURL` at it. Call at the top of the file; its tests share the server
 * and run in order, since each builds on the state the previous one left.
 */
export function useFreshServer(options: TestServerOptions = {}): {
  url(): string;
  /** A client of the server's database, for changes no page can make, such as time passing. The caller ends it. */
  connectDatabase(): Promise<pg.Client>;
} {
  // The server serves the built management interface.
  assertBuilt("web");
  let server: Promise<TestServer> | undefined;

  test.describe.configure({ mode: "serial" });
  // Started by the first test that needs it: Playwright resolves baseURL
  // before beforeAll hooks run.
  test.use({ baseURL: async ({}, use) => use((await (server ??= startTestServer(options))).url) });
  test.afterAll(async () => {
    await (await server)?.stop();
  });

  let url: string | undefined;
  test.beforeEach(async ({ baseURL }) => {
    url = baseURL;
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
  };
}
