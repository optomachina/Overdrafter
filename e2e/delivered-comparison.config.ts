import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// OVD-571 fixture lane: the real ClientQuoteDecisionPanel with synthetic quotes only.
export default defineConfig({
  forbidOnly: !!process.env.CI,
  testDir: ".", testMatch: "delivered-comparison.spec.ts", workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4175", headless: true,
    channel: process.env.CI === "true" && !process.env.DELIVERED_TEST_CHROMIUM ? "chrome" : undefined,
    launchOptions: { chromiumSandbox: true, ...(process.env.DELIVERED_TEST_CHROMIUM ? { executablePath: process.env.DELIVERED_TEST_CHROMIUM } : {}) },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: "node node_modules/vite/bin/vite.js --config e2e/delivered-comparison.vite.config.ts",
    url: "http://127.0.0.1:4175/fixture/delivered-comparison", reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: "http://127.0.0.1:9", VITE_SUPABASE_PUBLISHABLE_KEY: "synthetic-unused" },
  },
});
