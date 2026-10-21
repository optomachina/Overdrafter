import { test, expect } from "../test";

// OVD-1026: use the real notification hook and fixture activity gateway. No
// Notification stub or Supabase is needed to resolve permission and preferences.
test.describe("Client shell notifications", { tag: "@fixture" }, () => {
  test("keeps browser permission and client preferences available across client routes", async ({ page, context }, testInfo) => {
    test.setTimeout(120_000);
    await context.clearPermissions();
    const fixtureUrl = (route: string) => `${route}?fixture=client-published`;
    await page.goto(fixtureUrl("/quotes"));
    await page.locator("[data-client-shell]").waitFor();
    // Follow the actual short-code route generated for the accessible fixture job.
    const quoteHref = await page.locator('a[href^="/quotes/"]').first().getAttribute("href");
    expect(quoteHref).toBeTruthy();
    const quotePath = new URL(quoteHref!, page.url()).pathname;

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => localStorage.setItem("theme", value), theme);
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ["/parts", "/quotes", "/search", quotePath]) {
          await test.step(`${theme}, ${width}px, ${route}`, async () => {
            await page.goto(fixtureUrl(route));
            await page.locator("[data-client-shell]").waitFor();
            await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
            expect(await page.evaluate(() => typeof Notification === "function")).toBe(true);
            const permission = await page.evaluate(() => Notification.permission);

            await page.getByRole("button", { name: /open account menu/i }).click();
            await page.getByRole("menuitem", { name: /^Notifications/ }).click();
            const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
            const permissionCopy = {
              default: "Request browser permission here, then opt individual notification types into browser delivery.",
              denied: "Browser notifications are blocked for this site. Re-enable them in browser site settings.",
              granted: "This browser can receive notification deliveries when a channel is opted in below.",
            };
            await expect(panel.getByText(permissionCopy[permission], { exact: true })).toBeVisible();
            const allowNotifications = panel.getByRole("button", { name: "Allow browser notifications" });
            if (permission === "default") {
              await expect(allowNotifications).toBeEnabled();
            } else {
              await expect(allowNotifications).toHaveCount(0);
            }
            await expect(panel.getByRole("article").getByRole("heading", { name: "Quote package ready", exact: true })).toBeVisible();
            await expect(panel.getByRole("switch", { name: "Quote package ready In-app center" })).toBeChecked();
            await expect(panel.getByRole("switch", { name: "Quote package ready Browser alerts" })).toBeEnabled({ enabled: permission === "granted" });
            await expect(panel).not.toContainText("does not expose the Notification API");
            await expect(panel).not.toContainText("after a workspace role is resolved");
            expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

            if (route === "/search") {
              await testInfo.attach(`notifications-${theme}-${width}`, {
                body: await page.screenshot(),
                contentType: "image/png",
              });
            }
          });
        }
      }
    }
  });
});
