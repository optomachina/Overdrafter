import { test, expect } from "./test";

// Matches getSupabaseAuthStorageKey() for the local/fixture Supabase URLs (http://127.0.0.1:*).
const SUPABASE_TOKEN_KEY = "sb-127-auth-token";

// A signed-in browser reloading a part page has a persisted Supabase token but an empty
// in-memory query cache. The Supabase URL is unreachable here, so auth stays unverified.
test.describe("part page reload with a persisted session", { tag: "@fixture" }, () => {
  test("draws the shell instead of the boot screen and loads no part data before auth verifies", async ({ page }) => {
    // Keep every auth verification request pending so the page stays in isAuthInitializing.
    let releaseAuth!: () => void;
    const authHeld = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    await page.route("**/auth/v1/**", async (route) => {
      await authHeld;
      await route.abort().catch(() => undefined);
    });
    const dataRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.includes("/rest/v1/") || pathname.includes("/functions/v1/")) {
        dataRequests.push(`${request.method()} ${pathname}`);
      }
    });

    await page.addInitScript((key) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ access_token: "persisted-token", refresh_token: "persisted-refresh", expires_at: 4102444800 }),
      );
      const w = window as unknown as { __bootScreenSeen: boolean };
      w.__bootScreenSeen = false;
      new MutationObserver(() => {
        if (document.body?.textContent?.includes("Restoring your part workspace.")) {
          w.__bootScreenSeen = true;
        }
      }).observe(document, { childList: true, subtree: true, characterData: true });
    }, SUPABASE_TOKEN_KEY);

    await page.goto("/parts/job-1");
    await page.reload();

    await page.locator("[data-client-shell]").waitFor();
    await expect(page.getByText("Opening OverDrafter")).toHaveCount(0);
    await expect(page.getByRole("status", { name: "Restoring your part workspace" })).toBeVisible();
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => (window as unknown as { __bootScreenSeen: boolean }).__bootScreenSeen)).toBe(false);
    expect(dataRequests).toEqual([]);
    releaseAuth();
  });
});
