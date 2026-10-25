import { expect, type Locator } from "@playwright/test";

// The management interface's info icons (web/src/components/info-tip.tsx), each holding what explains the part beside it.

/** That the tooltip of the info icon about `subject` says `text`; it is closed again afterwards. */
export async function expectTip(scope: Locator, subject: string, text: string | RegExp) {
  const page = scope.page();
  await scope.getByRole("button", { name: `About ${subject}`, exact: true }).hover();
  await expect(page.getByRole("tooltip")).toHaveText(text);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

/** The events of a tap on a touchscreen, sent to the element alone: a touch's pointer events and a click, without the hover and focus Playwright's own tap brings. */
export async function tap(element: Locator) {
  for (const type of ["pointerdown", "pointerup"]) await element.dispatchEvent(type, { pointerType: "touch", isPrimary: true, bubbles: true });
  await element.dispatchEvent("click");
}
