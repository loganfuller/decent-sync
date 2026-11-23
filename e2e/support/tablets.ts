import { expect, type Page } from "@playwright/test";
import { syncingTablet } from "../../server/test/support/loaded-tablets.js";
import { type DecaidApi, type SimulatedTablet, derivedDe1Pro } from "../../server/test/support/simulated-tablet.js";

/**
 * A Machine at the Location, given by its id or as an object with one,
 * created through the REST API as the page's signed-in account, and its
 * tablet connected to the server, as `syncingTablet()` loads one: polling
 * every 5 s of its time, which runs 50 times faster here. Its Decaid answers
 * `api` over derivedDe1Pro()'s tablet with that serial, and loads it with
 * `options`, such as the plugins its Decaid lists and manages (`plugins`).
 */
export async function tabletAt(
  page: Page,
  server: { url(): string },
  name: string,
  location: string | { id: string },
  serial: string,
  api: DecaidApi = {},
  options: Omit<NonNullable<Parameters<typeof syncingTablet>[2]>, "api"> = {},
): Promise<SimulatedTablet> {
  const locationId = typeof location === "string" ? location : location.id;
  const response = await page.request.post("/api/machines", { data: { name, locationId } });
  expect(response.status(), await response.text()).toBe(201);
  const { token } = (await response.json()) as { token: string };
  const tablet = syncingTablet({ token }, { url: server.url() }, { ...options, api: { ...derivedDe1Pro({ serial }), ...api } });
  await tablet.waitForLog(/^Connected to /);
  return tablet;
}
