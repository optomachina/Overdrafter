import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".", testMatch: "*.browser.ts", workers: 1, fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:4175", headless: true, serviceWorkers: "block",
    channel: process.env.CI === "true" ? "chrome" : undefined,
    launchOptions: { chromiumSandbox: true },
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    command: "node node_modules/vite/bin/vite.js build --config e2e/quote-confirmation/vite.config.ts && node node_modules/vite/bin/vite.js preview --config e2e/quote-confirmation/vite.config.ts --host 127.0.0.1 --port 4175 --strictPort",
    timeout: 120000,
    url: "http://127.0.0.1:4175/e2e/quote-confirmation/index.html", reuseExistingServer: false,
  },
});
