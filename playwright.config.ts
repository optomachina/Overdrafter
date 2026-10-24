import { defineConfig } from "@playwright/test";

const LOCAL_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const fixtureOnly = process.env.PLAYWRIGHT_SKIP_AUTH_SETUP === "1";
const baseURL = fixtureOnly
  ? "http://127.0.0.1:4173"
  : process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  forbidOnly: !!process.env.CI,
  testDir: "./e2e",
  // Served only by its synthetic server; `npm run e2e:fixture` runs it through
  // e2e/delivered-comparison.config.ts.
  testIgnore: ["delivered-comparison.spec.ts"],
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.mjs",
  // The dev server serves ~340 unbundled modules before React mounts, so a cold
  // browser context can take over 5 s to paint its first heading. Match the
  // 15 s budget e2e/intake.spec.ts gives its first post login assertions.
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    headless: true,
    // Hosted Ubuntu already profiles installed Chrome for sandboxed execution.
    channel: process.env.CI === "true" ? "chrome" : undefined,
    // Exercise the real CAD canvas even on GPU-less fixture-test runners.
    launchOptions: {
      chromiumSandbox: true,
      ...(fixtureOnly ? { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {}),
    },
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173",
    env: {
      ...process.env,
      VITE_ENABLE_FIXTURE_MODE: "1",
      VITE_ENABLE_ENGINEERING_WORKBENCH: fixtureOnly ? "1" : "0",
      VITE_SUPABASE_URL: fixtureOnly
        ? "http://127.0.0.1:9"
        : process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321",
      VITE_SUPABASE_PUBLISHABLE_KEY: fixtureOnly
        ? LOCAL_SUPABASE_ANON_KEY
        : process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? LOCAL_SUPABASE_ANON_KEY,
    },
    reuseExistingServer: !fixtureOnly && !process.env.CI,
    timeout: 120000,
    url: baseURL,
  },
});
