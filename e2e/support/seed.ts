import { expect, type Page } from "@playwright/test";

// Seeds a spec's server through the REST API as the page's signed-in
// account, as Seam 1's admin-api.ts does for Vitest, which Playwright cannot
// import.

export const admin = { name: "Ada Admin", email: "ada@example.com", password: "correct horse battery" };

/**
 * Signs the page's context in as the Admin: the first test of a spec sets
 * the fresh server up with them, and later ones sign in.
 */
export async function signInAsAdmin(page: Page): Promise<void> {
  const setup = await page.request.post("/api/setup", { data: admin });
  if (setup.status() === 409) await page.request.post("/api/session", { data: admin });
  else expect(setup.status()).toBe(201);
}

export async function createLocation(page: Page, name: string, timeZone = "America/Chicago"): Promise<{ id: string; name: string; timeZone: string }> {
  const response = await page.request.post("/api/locations", { data: { name, timeZone } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string; name: string; timeZone: string } }).location;
}

/** Creates a machine entry, at a Location from now if one is given; its token is shown only now. */
export async function createMachine(
  page: Page,
  name: string,
  locationId?: string,
): Promise<{ machine: { id: string; name: string }; token: string; serverUrl: string }> {
  const response = await page.request.post("/api/machines", { data: { name, locationId } });
  expect(response.status()).toBe(201);
  return (await response.json()) as { machine: { id: string; name: string }; token: string; serverUrl: string };
}
