import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Public local-Supabase demo anon key (the same one playwright.config.ts uses); no backend answers it.
const LOCAL_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ORIGIN = "http://127.0.0.1:4176";
const DIST = "output/playwright/production-surface-dist";
const VITE = "node node_modules/vite/bin/vite.js";

// Serves a real production build (import.meta.env.DEV === false) so the spec sees what users get.
export default defineConfig({
  testDir: ".", testMatch: "production-surface.browser.ts", workers: 1, fullyParallel: false,
  use: {
    baseURL: ORIGIN, headless: true, serviceWorkers: "block",
    channel: process.env.CI === "true" ? "chrome" : undefined,
    launchOptions: { chromiumSandbox: true },
    screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  webServer: {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    command: `${VITE} build --mode production --outDir ${DIST} && ${VITE} preview --outDir ${DIST} --host 127.0.0.1 --port 4176 --strictPort`,
    // Pinned over the ambient environment: a production NODE_ENV, no fixture or workbench flags,
    // and an unreachable loopback Supabase URL.
    env: {
      NODE_ENV: "production",
      VITE_ENABLE_FIXTURE_MODE: "0",
      VITE_ENABLE_ENGINEERING_WORKBENCH: "0",
      OVD_SAMPLE_PLATE_DEMO_ENABLED: "0",
      VITE_SUPABASE_URL: "http://127.0.0.1:9",
      VITE_SUPABASE_PUBLISHABLE_KEY: LOCAL_SUPABASE_ANON_KEY,
    },
    url: `${ORIGIN}/legal/terms`, reuseExistingServer: false, timeout: 180000,
  },
});
