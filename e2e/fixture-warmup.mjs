import { chromium } from "@playwright/test";

// The fixture lane runs against the Vite dev server, which transforms each lazy
// route chunk on first request. Without a warm-up, whichever parallel test hits a
// route first spends its first-mount assertion budget waiting for compilation.
const FIXTURE_WARMUP_ROUTES = [
  "/?debug=1",
  "/parts?fixture=client-quoted&debug=1",
  "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1",
  "/parts/fx-job-published?fixture=client-published&debug=1",
  "/projects/fx-project-quoted?fixture=client-quoted&debug=1",
  "/quotes?fixture=client-quoted&debug=1",
  "/search?fixture=client-quoted&debug=1",
  "/engineering?fixture=client-quoted",
  "/dev/engineering",
  "/internal/admin",
];

/** Visit each fixture route once so parallel tests do not pay first-compile cost. */
export async function warmFixtureRoutes(baseURL) {
  const browser = await chromium.launch({ chromiumSandbox: true, channel: process.env.CI === "true" ? "chrome" : undefined });
  try {
    const page = await browser.newPage();
    for (const route of FIXTURE_WARMUP_ROUTES) {
      // Warm-up only: a slow or failing route must surface in its own test, not here.
      await page.goto(new URL(route, baseURL).href, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
    }
  } finally {
    await browser.close();
  }
}

