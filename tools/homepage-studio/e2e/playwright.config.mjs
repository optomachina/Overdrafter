// Separate Playwright config for the Homepage Studio end-to-end suite. Not the repo's root config.
//   npx playwright test -c tools/homepage-studio/e2e/playwright.config.mjs [--project=studio-local] [--grep @a11y]
// Servers are started per test/worker inside the test process (see helpers/fixtures.mjs), each with its own temp data
// directory and an ephemeral 127.0.0.1 port, so no webServer block (and no fixed port) is needed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { outputRoot } from "./helpers/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ci = !!process.env.CI;

export default defineConfig({
  testDir: path.join(here, "specs"),
  outputDir: path.join(outputRoot, "test-results"),
  snapshotPathTemplate: path.join(outputRoot, "snapshots", "{testFilePath}", "{arg}{ext}"),
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(outputRoot, "report"), open: "never" }],
  ],
  fullyParallel: true,
  workers: ci ? 2 : 2,
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    acceptDownloads: false,
  },
  projects: [
    { name: "studio-local", testMatch: /studio-local-.*\.spec\.mjs$/ },
    { name: "studio-hosted", testMatch: /studio-hosted.*\.spec\.mjs$/ },
    { name: "pages", testMatch: /pages-.*\.spec\.mjs$/ },
    { name: "security", testMatch: /security.*\.spec\.mjs$/ },
    { name: "a11y", testMatch: /a11y\.spec\.mjs$/ },
  ],
});
