import { test as base, expect } from "@playwright/test";

export const test = base;

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) {
    return;
  }

  const diagnostics = await page
    .evaluate(() => window.__OVERDRAFTER_DEBUG__?.getSnapshot() ?? null)
    .catch(() => null);

  if (diagnostics) {
    await testInfo.attach("diagnostics", {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: "application/json",
    });
  }
});

export { expect };
