import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "admin-operations.spec.ts", workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174", headless: true,
    channel: process.env.CI === "true" && !process.env.ADMIN_TEST_CHROMIUM ? "chrome" : undefined,
    launchOptions: { chromiumSandbox: true, ...(process.env.ADMIN_TEST_CHROMIUM ? { executablePath: process.env.ADMIN_TEST_CHROMIUM } : {}) },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: "node node_modules/vite/bin/vite.js --config e2e/admin-operations.vite.config.ts",
    url: "http://127.0.0.1:4174/internal/admin", reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: "http://127.0.0.1:9", VITE_SUPABASE_PUBLISHABLE_KEY: "synthetic-unused" },
  },
});
