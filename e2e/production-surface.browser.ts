import { expect, test, type Page } from "@playwright/test";

// Runs only through e2e/production-surface.config.ts, which serves a `vite build --mode production` bundle.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const NOT_FOUND_TEXT = "The route you requested does not exist in this app.";
const GALLERY_HEADINGS = ["UI Direction Explorations", "Review OverDrafter states without hunting through flows"];
const DEBUG_ONLY_ROUTES = ["/debug/concepts", "/debug/state-gallery", "/dev-login", "/engineering", "/dev/engineering"];

test.beforeEach(async ({ context }) => {
  // Containment: nothing in this lane may leave the machine.
  await context.route("**/*", (route) => (
    LOOPBACK_HOSTS.has(new URL(route.request().url()).hostname) ? route.fallback() : route.abort("blockedbyclient")
  ));
  await context.routeWebSocket(/.*/, (socket) => (
    LOOPBACK_HOSTS.has(new URL(socket.url()).hostname) ? socket.connectToServer() : socket.close()
  ));
});

async function expectNoAnnotationToolbar(page: Page) {
  await expect(page.getByTitle("Start feedback mode", { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-agentation-toolbar]")).toHaveCount(0);
}

test("positive control: a production route renders its content, not the 404", async ({ page }) => {
  await page.goto("/legal/terms");
  await expect(page.getByRole("heading", { level: 1, name: "Founding Beta Terms" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "404" })).toHaveCount(0);
  await expect(page.getByText(NOT_FOUND_TEXT)).toHaveCount(0);
  await page.waitForLoadState("load");
  await expectNoAnnotationToolbar(page);
});

for (const route of DEBUG_ONLY_ROUTES) {
  test(`${route} is not served in a production build`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1, name: "404" })).toBeVisible();
    await expect(page.getByText(NOT_FOUND_TEXT)).toBeVisible();
    for (const heading of GALLERY_HEADINGS) {
      await expect(page.getByRole("heading", { name: heading })).toHaveCount(0);
    }
    await expectNoAnnotationToolbar(page);
  });
}

test("fixture scenarios are inert in a production build", async ({ page }) => {
  await page.goto("/parts?fixture=client-quoted");
  const fixturePanel = page.locator("[data-fixture-panel]");
  const guestSignIn = page.getByRole("button", { name: "Sign in", exact: true });
  // Settle on whichever surface the build renders before asserting absence.
  await expect(guestSignIn.or(fixturePanel).first()).toBeVisible();
  await expect(fixturePanel).toHaveCount(0);
  await expect(guestSignIn).toBeVisible();
  await expectNoAnnotationToolbar(page);
});
