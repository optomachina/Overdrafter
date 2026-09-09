import { readFile } from "node:fs/promises";
import { test, expect } from "./test";

test.describe("internal engineering handoff", { tag: "@fixture" }, () => {
  test("preserves five requests and exact export bytes through refresh", async ({ page }, testInfo) => {
    await page.goto("/dev/engineering");
    await expect(page.getByRole("heading", { name: "Prepared assembly workbench" })).toBeVisible();
    await page.getByLabel("Import prepared context").setInputFiles({
      name: "context.json", mimeType: "application/json",
      buffer: await readFile(new URL("./fixtures/prepared-assembly-context.json", import.meta.url)),
    });
    await page.getByLabel("Requested depth (mm)").fill("8");
    await page.getByRole("button", { name: "Queue dimension change" }).click();
    await expect(page.getByRole("button", { name: /^01 · 5 → 8 mm/ })).toBeVisible();
    const firstDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download request JSON" }).click();
    const firstPath = testInfo.outputPath("first-request.json");
    await (await firstDownload).saveAs(firstPath);

    for (const depth of [9, 10, 6, 7]) {
      await page.getByLabel("Requested depth (mm)").fill(String(depth));
      await page.getByRole("button", { name: "Queue dimension change" }).click();
    }
    await expect(page.getByRole("list", { name: "Queued decisions" }).getByRole("button")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Queue dimension change" })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("list", { name: "Queued decisions" }).getByRole("button")).toHaveCount(5);
    await page.getByRole("button", { name: /^01 · 5 → 8 mm/ }).click();
    const repeatedDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download request JSON" }).click();
    const repeatedPath = testInfo.outputPath("repeated-request.json");
    await (await repeatedDownload).saveAs(repeatedPath);
    expect(await readFile(repeatedPath)).toEqual(await readFile(firstPath));
    await expect(page.getByText("Unverified", { exact: true })).toBeVisible();
    await expect(page.getByText("Not adopted", { exact: true })).toBeVisible();

    await page.getByLabel("Import native result").setInputFiles({
      name: "malformed-result.json", mimeType: "application/json", buffer: Buffer.from("{"),
    });
    await expect(page.getByRole("alert")).toContainText("invalid JSON");
    await expect(page.getByText("Unverified", { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Queued decisions" }).getByRole("button")).toHaveCount(5);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
