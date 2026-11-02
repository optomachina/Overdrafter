import type { Page } from "@playwright/test";
import { test, expect } from "../test";

// OVD-825 front-door journey: a phone user starts at the public root, finds
// Jarvis without typing a URL, asks for a part and gets a viewable 3D result.
// Fixture mode only: the client session comes from `?fixture=`, no Supabase.

const STEP_TIMEOUT = 5_000;
const PROMPT = "design a 4 inch square plate";

const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

const PHONES = [
  { name: "375x812", viewport: { width: 375, height: 812 } },
  { name: "430x932", viewport: { width: 430, height: 932 } },
] as const;

async function signInIfAsked(page: Page) {
  // Fixture sessions are already signed in; a real front door may still ask.
  const email = page.locator("#auth-email");
  if (await email.isVisible().catch(() => false)) {
    await page.goto("/?fixture=client-quoted&debug=1");
  }
}

// The front door: a visible link or button to Jarvis from the public root.
function jarvisDoor(page: Page) {
  return page.getByRole("link", { name: /jarvis/i }).or(page.getByRole("button", { name: /jarvis/i })).first();
}

async function openPublicRoot(page: Page) {
  await page.goto("/?fixture=client-quoted&debug=1");
  // Readiness for the lazily mounted app shell (see e2e/client-shell.spec.ts); not part of the journey budget.
  await page.locator("[data-client-shell]").waitFor({ timeout: 30_000 });
  await signInIfAsked(page);
}

for (const phone of PHONES) {
  test.describe(`Jarvis front door on a ${phone.name} phone`, { tag: "@fixture" }, () => {
    // Android Chrome, so the result offers Scene Viewer AR the way it does on a real phone.
    test.use({ viewport: phone.viewport, isMobile: true, hasTouch: true, userAgent: ANDROID_CHROME });

    // Boot guard: a normal test, so a broken app or fixture is red on its own.
    test("boot guard: fixture loads and the client shell mounts", async ({ page }) => {
      await page.goto("/?fixture=client-quoted&debug=1");
      await expect(page.locator("[data-client-shell]")).toBeVisible({ timeout: 30_000 });
    });

    test("public root -> Jarvis -> 4 inch plate -> PNG, GLB/USDZ and AR link", async ({ page }) => {
      test.setTimeout(60_000);

      await openPublicRoot(page);

      const door = jarvisDoor(page);
      await expect(door, "no public link to Jarvis on /").toBeVisible({ timeout: STEP_TIMEOUT });
      await door.tap();

      const composer = page.getByRole("textbox", { name: /message|ask|jarvis|describe/i }).first();
      await expect(composer).toBeVisible({ timeout: STEP_TIMEOUT });
      await composer.fill(PROMPT);
      await composer.press("Enter");

      await expect(page.getByText(PROMPT).first()).toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(page.getByRole("status").first(), "no status update").toBeVisible({ timeout: STEP_TIMEOUT });

      const resultCard = page.locator("[data-jarvis-result]").or(page.getByRole("article", { name: /result|plate/i })).first();
      await expect(resultCard, "no result card").toBeVisible({ timeout: STEP_TIMEOUT });
      await expect(resultCard.locator('img[src*=".png"], img[src^="data:image/png"]').first(), "no PNG render").toBeVisible({
        timeout: STEP_TIMEOUT,
      });
      await expect(
        resultCard.locator('a[href*=".glb"], a[href*=".usdz"], model-viewer[src*=".glb"]').first(),
        "no GLB/USDZ model",
      ).toBeAttached({ timeout: STEP_TIMEOUT });
      await expect(
        resultCard.getByRole("link", { name: /view in ar|ar/i }).or(resultCard.locator('a[rel="ar"]')).first(),
        "no AR link",
      ).toBeVisible({ timeout: STEP_TIMEOUT });
    });
  });
}
