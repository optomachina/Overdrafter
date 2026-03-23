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

  test("keeps the client session after a home page reload", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);
  });

  test("keeps the client session after reloading a protected part route", async ({ page }) => {
    await page.goto("/parts/job-1?debug=1");

    await expect(page).toHaveURL(/\/parts\/job-1/);
    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/parts\/job-1/);
    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);
  });

  test("restores the homepage workspace after logging out, logging back in, and reloading", async ({ page }) => {
    await page.goto("/?debug=1");

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();

    await page.getByRole("button", { name: /open account menu/i }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await page.getByRole("button", { name: "Log out" }).click();

    await expect(page.locator("#auth-email")).toBeVisible();

    await page.locator("#auth-email").fill("client.demo@overdrafter.local");
    await page.locator("#auth-password").fill("Overdrafter123!");
    await page.getByRole("button", { name: /^Log in$/ }).click();

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);

    await page.reload({ waitUntil: "networkidle" });

    await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible();
    await expect(page.getByText("Q1 Brackets")).toBeVisible();
    await expect(page.locator("#auth-email")).toHaveCount(0);
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
