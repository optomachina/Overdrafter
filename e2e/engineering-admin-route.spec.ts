import path from "node:path";
import { createServer, type PreviewServer, type ViteDevServer } from "vite";
import type { Page } from "@playwright/test";
import { test, expect } from "./test";
import { buildProductionApp, repoRoot as root, servePreviewBuild, viteConfigFile as configFile, withEnv } from "./vite-preview-build";

// Synthetic only: every Supabase call targets a closed loopback port and is answered by the browser fixture.
const supabaseOrigin = "http://127.0.0.1:9";
const notFound = "The route you requested does not exist in this app.";
// A string literal unique to the engineering inbox page survives minification.
const inboxSentinel = "Request recorded. CAD execution has not been confirmed.";
// Vite's build sets NODE_ENV for the whole process, so each scoped step restores it afterwards.
const baseEnv = {
  NODE_ENV: undefined,
  VITE_SUPABASE_URL: supabaseOrigin,
  VITE_SUPABASE_PUBLISHABLE_KEY: "synthetic-unused",
  VITE_ENABLE_ENGINEERING_WORKBENCH: undefined,
  VITE_ENABLE_ENGINEERING_ADMIN_ROUTE: undefined,
  VITE_ENABLE_FIXTURE_MODE: undefined,
};

function buildApp(outDir: string, flag: string | undefined) {
  return buildProductionApp(outDir, { ...baseEnv, VITE_ENABLE_ENGINEERING_ADMIN_ROUTE: flag });
}

function servePreview(outDir: string, port: number): Promise<PreviewServer> {
  return servePreviewBuild(outDir, port, baseEnv);
}

/** Answers Supabase with a signed out auth state and the given admin decision; records what the page requested. */
async function fixtureNetwork(page: Page, appOrigin: string, isAdmin: boolean) {
  const requested: string[] = [];
  const adminChecks: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    requested.push(url.pathname);
    if (url.origin === appOrigin) return route.continue();
    if (url.origin !== supabaseOrigin) return route.abort();
    if (url.pathname === "/rest/v1/rpc/api_get_is_platform_admin") {
      adminChecks.push(route.request().method());
      return route.fulfill({ json: isAdmin });
    }
    if (url.pathname.startsWith("/auth/v1/")) return route.fulfill({ status: 401, json: { message: "no session" } });
    return route.fulfill({ status: 404, json: { message: "synthetic fixture has no data here" } });
  });
  return { requested, adminChecks };
}

test.describe("hosted engineering admin route", { tag: "@fixture" }, () => {
  test.describe.configure({ mode: "serial" });

  test("flag off compiles the route out; quote routes load no engineering code", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const outDir = testInfo.outputPath("dist-flag-off");
    const off = await buildApp(outDir, undefined);
    expect(off.assets.filter((file) => /Engineering/.test(file))).toEqual([]);
    expect(off.assets.filter((file) => file.endsWith(".js") && off.read(`assets/${file}`).includes(inboxSentinel))).toEqual([]);
    expect(Object.keys(off.manifest).filter((key) => key.includes("Engineering"))).toEqual([]);

    const server = await servePreview(outDir, 4181);
    try {
      const origin = "http://127.0.0.1:4181";
      const network = await fixtureNetwork(page, origin, true);
      await page.goto(`${origin}/engineering`);
      await expect(page.getByText(notFound)).toBeVisible();
      for (const route of ["/quotes", "/parts", "/"]) {
        await page.goto(`${origin}${route}`);
        await expect(page.locator("#root")).not.toBeEmpty();
        await expect(page.getByText(notFound)).toHaveCount(0);
      }
      expect(network.requested.filter((pathname) => /Engineering/.test(pathname))).toEqual([]);
      expect(network.adminChecks).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("flag on keeps engineering code out of the entry chunk and hides the page from signed out visitors", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const outDir = testInfo.outputPath("dist-flag-on");
    const on = await buildApp(outDir, "1");
    const gate = on.manifest["src/pages/EngineeringAdminRoute.tsx"];
    const inbox = on.manifest["src/pages/EngineeringInbox.tsx"];
    expect(gate?.file).toMatch(/^assets\/EngineeringAdminRoute-/);
    expect(inbox?.file).toMatch(/^assets\/EngineeringInbox-/);
    expect(gate.dynamicImports).toContain("src/pages/EngineeringInbox.tsx");
    expect(on.read(inbox.file)).toContain(inboxSentinel);
    for (const file of on.entryClosure) {
      expect(file).not.toMatch(/Engineering/);
      expect(on.read(file)).not.toContain(inboxSentinel);
    }
    const chunksWithInbox = on.assets.filter((file) => file.endsWith(".js") && on.read(`assets/${file}`).includes(inboxSentinel));
    expect(chunksWithInbox).toEqual([path.basename(inbox.file)]);

    const server = await servePreview(outDir, 4182);
    try {
      const origin = "http://127.0.0.1:4182";
      const network = await fixtureNetwork(page, origin, true);
      await page.goto(`${origin}/quotes`);
      await expect(page.locator("#root")).not.toBeEmpty();
      await expect(page.getByText(notFound)).toHaveCount(0);
      expect(network.requested.filter((pathname) => /Engineering/.test(pathname))).toEqual([]);

      await page.goto(`${origin}/engineering`);
      await expect(page.getByText(notFound)).toBeVisible();
      expect(network.adminChecks).toEqual([]);
      expect(network.requested.filter((pathname) => /EngineeringInbox/.test(pathname))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("a signed in user reaches the inbox only when the server allowlist admits them", async ({ browser }, testInfo) => {
    test.setTimeout(180_000);
    const port = 4183;
    const origin = `http://127.0.0.1:${port}`;
    const server: ViteDevServer = await withEnv({ ...baseEnv, VITE_ENABLE_ENGINEERING_ADMIN_ROUTE: "1" }, async () => {
      // A private dependency cache keeps this server from rewriting node_modules/.vite under the suite's own dev servers.
      const dev = await createServer({
        configFile, root, logLevel: "silent", cacheDir: testInfo.outputPath("vite-cache"),
        server: { host: "127.0.0.1", port, strictPort: true },
      });
      return dev.listen();
    });
    const conversation = "10000000-0000-4000-8000-000000000001";
    const target = `${origin}/engineering?conversation=${conversation}&fixture=client-quoted`;
    try {
      const denied = await browser.newPage();
      const deniedNetwork = await fixtureNetwork(denied, origin, false);
      await denied.goto(target);
      await expect(denied.getByText(notFound)).toBeVisible({ timeout: 60_000 });
      expect(deniedNetwork.adminChecks).toEqual(["POST"]);
      expect(deniedNetwork.requested.filter((pathname) => /EngineeringInbox/.test(pathname))).toEqual([]);
      await denied.close();

      const admitted = await browser.newPage();
      const admittedNetwork = await fixtureNetwork(admitted, origin, true);
      await admitted.goto(target);
      await expect(admitted.getByText("Conversation unavailable. Check your access and try again.")).toBeVisible({ timeout: 60_000 });
      await expect(admitted.getByText(notFound)).toHaveCount(0);
      expect(admittedNetwork.adminChecks).toEqual(["POST"]);
      expect(admittedNetwork.requested.some((pathname) => pathname.endsWith("/src/pages/EngineeringInbox.tsx"))).toBe(true);
      await admitted.close();
    } finally {
      await server.close();
    }
  });
});
