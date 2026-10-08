import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, acceptInvite } from "./support/admin-api.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Who may use each REST route, through the REST API. The routes are those the
// server maps at startup, read from its log, so a route added later is checked
// too. Every route requires a signed-in Admin unless marked @Public() or
// @AllowStaff() (server/src/accounts/guards.ts); these lists name the routes
// so marked. Files on each feature test what a route does once let through.

/** Routes anyone may use, signed in or not. */
const PUBLIC = [
  "GET /api/health",
  "GET /api/setup",
  "POST /api/setup",
  "POST /api/session",
  "GET /api/invite-links/:secret",
  "POST /api/invite-links/:secret/accept",
  "GET /api/password-reset-links/:secret",
  "POST /api/password-reset-links/:secret/redeem",
];

/** Routes Staff may use too: reading everything but other accounts, and moving Machines between their Locations. */
const STAFF = [
  "GET /api/session",
  "DELETE /api/session",
  "GET /api/beans",
  "GET /api/beans/:id",
  "GET /api/bean-batches",
  "GET /api/bean-batches/:id",
  "GET /api/locations",
  "GET /api/time-zones",
  "GET /api/machines",
  "GET /api/machines/models",
  "GET /api/machines/:id",
  "POST /api/machines/:id/location-history",
  "GET /api/machines/:id/workflow",
  "GET /api/machines/:id/workflow-events",
  "GET /api/machines/:id/machine-state-events",
  "GET /api/machines/:id/collections",
  "GET /api/machines/:id/collections/:name",
  "GET /api/machines/:id/paired-devices",
  "GET /api/machines/:id/set-aside-deliveries",
  "GET /api/pending-machines",
  "GET /api/pending-machines/:id",
  "GET /api/shots",
  "GET /api/shots/filters",
  "GET /api/shots/:id",
  "GET /api/shots/:id/measurements",
  "GET /api/steam-records",
  "GET /api/steam-records/:id",
  "GET /api/steam-records/:id/measurements",
];

interface Route {
  method: string;
  path: string;
  name: string;
}

describe("who may use each route", () => {
  let server: TestServer;
  let staff: AdminApi;
  let routes: Route[];

  beforeAll(async () => {
    server = await startTestServer();
    const api = await AdminApi.setUp(server.url);
    const lab = await api.createLocation("Lab", "UTC");
    const { link } = await api.invite("sam@example.com", "staff", [lab.id]);
    staff = AdminApi.signedInAs(server.url, await acceptInvite(server.url, link, { name: "Sam Staff", password: "sam's password" }));
    routes = [...server.output().matchAll(/Mapped \{(\/\S+), (\w+)\} route/g)].map(([, path, method]) => ({
      method: method!,
      path: path!,
      name: `${method} ${path}`,
    }));
    // Signing out last, as it ends Sam's session.
    routes.sort((a, b) => Number(a.name === "DELETE /api/session") - Number(b.name === "DELETE /api/session"));
  }, 60_000);
  afterAll(async () => {
    await server?.stop();
  });

  /** Calls the route, each parameter filled in with an id nothing has, as Sam or signed out. */
  async function refusal(route: Route, asStaff: boolean): Promise<{ status: number; message: unknown }> {
    const path = route.path.replace(/^\/api/, "").replace(/:\w+/g, () => randomUUID());
    const response = asStaff ? await staff.call(route.method, path) : await staff.call(route.method, path, undefined, {});
    const body = await response.text();
    return { status: response.status, message: body.startsWith("{") ? (JSON.parse(body) as { message?: unknown }).message : body };
  }

  it("names only routes the server maps", () => {
    expect(routes.length).toBeGreaterThan(PUBLIC.length + STAFF.length);
    expect([...PUBLIC, ...STAFF].filter((name) => !routes.some((route) => route.name === name))).toEqual([]);
  });

  it("refuses every route but the public ones to anyone not signed in", async () => {
    for (const route of routes) {
      const { status, message } = await refusal(route, false);
      if (PUBLIC.includes(route.name)) expect(status, route.name).not.toBe(401);
      else expect({ route: route.name, status, message }).toEqual({ route: route.name, status: 401, message: "Sign in to continue" });
    }
  });

  it("refuses Staff every route but the public ones and those for Staff", async () => {
    for (const route of routes.filter((route) => !PUBLIC.includes(route.name))) {
      const { status, message } = await refusal(route, true);
      const refused = status === 403 && message === "Only an Admin can do this";
      expect({ route: route.name, refused, status }).toEqual({ route: route.name, refused: !STAFF.includes(route.name), status: expect.any(Number) });
    }
  });
});
