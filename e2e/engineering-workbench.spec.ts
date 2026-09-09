import { readFile } from "node:fs/promises";
import { test, expect } from "./test";

test.describe("internal engineering handoff", { tag: "@fixture" }, () => {
  test("preserves five requests and exact export bytes through refresh", async ({ page }, testInfo) => {
    await page.goto("/dev/engineering");
    await expect(page.getByRole("region", { name: "Engineering conversation" })).toBeVisible();
    await page.getByText("Workbench tools", { exact: true }).click();
    await page.getByLabel("Import prepared context").setInputFiles({
      name: "context.json", mimeType: "application/json",
      buffer: await readFile(new URL("./fixtures/prepared-assembly-context.json", import.meta.url)),
    });
    await page.getByRole("textbox", { name: "Message" }).fill("Make it thicker");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/What target depth should the baseline part have/)).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("8");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText(/Which units do you mean for 8/)).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("mm");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: /^01 · 5 → 8 mm/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Evaluate this change" }).click();
    await expect(page.getByRole("button", { name: /^01 · 5 → 8 mm/ })).toBeVisible();
    const firstDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download request JSON" }).click();
    const firstPath = testInfo.outputPath("first-request.json");
    await (await firstDownload).saveAs(firstPath);

    for (const depth of [9, 10, 6, 7]) {
      await page.getByRole("textbox", { name: "Message" }).fill(`Set the depth to ${depth} mm`);
      await page.getByRole("button", { name: "Send message" }).click();
      await page.getByRole("button", { name: "Evaluate this change" }).click();
    }
    await expect(page.getByRole("button", { name: /^0[1-5] · 5 →/ })).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await page.reload();
    await page.getByText("Workbench tools", { exact: true }).click();
    await expect(page.getByRole("button", { name: /^0[1-5] · 5 →/ })).toHaveCount(5);
    await page.getByRole("button", { name: /^01 · 5 → 8 mm/ }).click();
    const repeatedDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download request JSON" }).click();
    const repeatedPath = testInfo.outputPath("repeated-request.json");
    await (await repeatedDownload).saveAs(repeatedPath);
    expect(await readFile(repeatedPath)).toEqual(await readFile(firstPath));
    await expect(page.getByText("Unverified · Not adopted", { exact: true })).toBeVisible();

    await page.getByLabel("Import native result").setInputFiles({
      name: "malformed-result.json", mimeType: "application/json", buffer: Buffer.from("{"),
    });
    await expect(page.getByRole("alert")).toContainText("invalid JSON");
    await expect(page.getByText("Unverified · Not adopted", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^0[1-5] · 5 →/ })).toHaveCount(5);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
