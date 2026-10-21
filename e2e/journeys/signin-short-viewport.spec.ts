import { test, expect } from "../test";

test.describe("Auth dialog on short viewports", { tag: "@fixture" }, () => {
  test("keeps headers visible and auth actions reachable in both themes", async ({ page }) => {
    test.setTimeout(120_000);
    // next-themes reads this preference before rendering the auth panel.
    await page.addInitScript(() => {
      localStorage.setItem("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    });

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const viewport of [{ width: 1366, height: 657 }, { width: 375, height: 667 }]) {
        for (const mode of ["signin", "signup"] as const) {
          await test.step(`${theme}, ${viewport.width}x${viewport.height}, ${mode}`, async () => {
            await page.setViewportSize(viewport);
            await page.goto(`/?fixture=landing-anonymous&auth=${mode}&debug=1`);
            await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));

            const dialog = page.getByRole("dialog");
            // The panel's visible h2 is aria-hidden in favor of the dialog title.
            const heading = dialog.locator("h2[aria-hidden='true']");
            await expect(heading).toHaveText(mode === "signin" ? "Log in to OverDrafter" : "Create your account");
            await expect(heading).toBeInViewport({ ratio: 1 });

            await dialog.getByLabel("Email", { exact: true }).fill("viewport@example.test");
            await dialog.getByLabel("Password", { exact: true }).fill("Synthetic-password-123!");
            const submit = dialog.locator("form").getByRole("button", {
              name: mode === "signin" ? "Log in" : "Create account",
              exact: true,
            });
            await submit.scrollIntoViewIfNeeded();
            await expect(submit).toBeInViewport({ ratio: 1 });
            // Check pointer actionability without sending an authentication request.
            await submit.click({ trial: true });

            if (mode === "signin") {
              const forgotPassword = dialog.getByRole("button", { name: "Forgot password?", exact: true });
              await forgotPassword.scrollIntoViewIfNeeded();
              await expect(forgotPassword).toBeInViewport({ ratio: 1 });
              await forgotPassword.click({ trial: true });
            }

            const switchMode = dialog.locator("p").getByRole("button", {
              name: mode === "signin" ? "Sign up" : "Log in",
              exact: true,
            });
            await switchMode.scrollIntoViewIfNeeded();
            await expect(switchMode).toBeInViewport({ ratio: 1 });
            await switchMode.click({ trial: true });
            expect(await dialog.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

            await heading.scrollIntoViewIfNeeded();
            await expect(heading).toBeInViewport({ ratio: 1 });
          });
        }
      }
    }
  });
});
