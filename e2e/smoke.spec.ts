import { test, expect } from "./test";

test("anonymous landing opens the auth dialog", async ({ page }) => {
  await page.goto("/?auth=signin&debug=1");

  await expect(page.locator("#auth-email")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Log in$/ })).toBeVisible();
});

test.describe("client session", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("shows the client workspace shell", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
  });
});

test.describe("internal session", () => {
  test.use({ storageState: "playwright/.auth/internal.json" });

  test("shows the operations dashboard", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByText("Operations Dashboard")).toBeVisible();
    await expect(page.getByText("Total jobs")).toBeVisible();
  });
});

test("fixture mode renders without a signed-in backend session", async ({ page }) => {
  await page.goto("/projects/fx-project-quoted?fixture=client-quoted&debug=1");

  await expect(page.getByText("Q1 Brackets")).toBeVisible();
  await expect(page.getByRole("button", { name: /fixtures/i })).toBeVisible();
});
