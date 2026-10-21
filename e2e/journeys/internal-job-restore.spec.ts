import { test, expect } from "../test";

// Uses the estimator session and jobs from the local seeded Supabase stack.
test.describe("internal job session restoration", () => {
  test.use({ storageState: "playwright/.auth/internal.json" });

  test("opens a dashboard job and restores it after three hard reloads", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Operations Dashboard", exact: true })).toBeVisible();

    const firstJob = page.getByRole("region", { name: "Jobs", exact: true })
      .getByRole("link")
      .first();
    await expect(firstJob).toBeVisible();
    await expect(firstJob).toHaveAttribute("href", /^\/internal\/jobs\/[^/?#]+$/);
    const jobPath = await firstJob.getAttribute("href");
    const jobTitle = (await firstJob.innerText()).trim();
    expect(jobTitle).not.toBe("");
    if (!jobPath) throw new Error("The dashboard job link must have an href.");

    const restoreMessage = page.getByText("Restoring your internal review session.", { exact: true });
    const assertJobLoaded = async () => {
      await expect(restoreMessage).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: jobTitle, exact: true, level: 1 })).toBeVisible();
      await expect(restoreMessage).toBeHidden();
      await expect(page).toHaveURL(jobPath);
    };

    await firstJob.click();
    await assertJobLoaded();

    for (let reload = 1; reload <= 3; reload += 1) {
      await test.step(`hard reload ${reload} preserves the job detail route`, async () => {
        await page.reload();
        await assertJobLoaded();
      });
    }
  });

  test("restores a hard load of the new job form", async ({ page }) => {
    await page.goto("/jobs/new");

    await expect(page.getByRole("heading", { name: "Create CNC Quote Job", exact: true })).toBeVisible();
    await expect(page.getByLabel("Job title", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Description", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create and queue extraction", exact: true })).toBeVisible();
    await expect(page).toHaveURL("/jobs/new");
  });
});
