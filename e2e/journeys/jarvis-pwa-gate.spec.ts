import type { PreviewServer } from "vite";
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../test";
import { createJarvisPwaHandler, type JarvisGateCaller } from "../../server/jarvis/pwa-gate";
import { buildProductionApp, servePreviewBuild } from "../vite-preview-build";

const notFound = "The route you requested does not exist in this app.";
const threadSentinel = "design a 4 inch square plate";
const shellSentinel = "data-jarvis-pwa-shell";
const NOT_LISTED = "synthetic-not-listed-token";
const AAL1 = "synthetic-aal1-blaine-token";
const AAL2 = "synthetic-aal2-blaine-token";

const baseEnv = {
  NODE_ENV: undefined,
  VITE_SUPABASE_URL: "http://127.0.0.1:9",
  VITE_SUPABASE_PUBLISHABLE_KEY: "synthetic-unused",
  VITE_ENABLE_ENGINEERING_WORKBENCH: undefined,
  VITE_ENABLE_ENGINEERING_ADMIN_ROUTE: undefined,
  VITE_ENABLE_FIXTURE_MODE: undefined,
  JARVIS_PWA_ENABLED: undefined,
};

const handler = createJarvisPwaHandler({
  enabled: true,
  lookup: async (token): Promise<JarvisGateCaller | null> => {
    if (token === AAL2) return { userId: "blaine", allowlisted: true, aal2: true };
    if (token === AAL1) return { userId: "blaine", allowlisted: true, aal2: false };
    if (token === NOT_LISTED) return { userId: "other", allowlisted: false, aal2: true };
    return null;
  },
}, "session");

function buildApp(outDir: string, flag: string | undefined) {
  return buildProductionApp(outDir, { ...baseEnv, JARVIS_PWA_ENABLED: flag });
}

function servePreview(outDir: string, port: number): Promise<PreviewServer> {
  return servePreviewBuild(outDir, port, baseEnv);
}

async function fulfillGate(route: Route, statuses: number[]) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(route.request().headers())) headers.set(key, value);
  const response = await handler(new Request(route.request().url(), { method: route.request().method(), headers }));
  statuses.push(response.status);
  const body = await response.text();
  const outgoing: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key === "content-length" || key === "transfer-encoding") return;
    outgoing[key] = value;
  });
  await route.fulfill({ status: response.status, headers: outgoing, body });
}

async function seedToken(page: Page, token: string | null) {
  await page.addInitScript((value) => {
    localStorage.setItem("jarvis-role", "admin");
    localStorage.setItem("JARVIS_PWA_ENABLED", "1");
    // Supabase drops a stored session that lacks refresh_token and expires_at
    // before the lazy gate can read it. A far-future expiry keeps the access
    // token in place without a refresh against the fixture host.
    if (value) {
      localStorage.setItem("sb-127-auth-token", JSON.stringify({
        access_token: value,
        refresh_token: "synthetic-refresh",
        expires_at: 4_102_444_800,
      }));
    }
  }, token);
}

test.describe("Jarvis PWA shell and gate", { tag: "@fixture" }, () => {
  test.describe.configure({ mode: "serial" });

  test("flag off compiles the route out and leaves quote routes unchanged", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const outDir = testInfo.outputPath("dist-flag-off");
    const off = await buildApp(outDir, undefined);
    expect(Object.keys(off.manifest).filter((key) => /Jarvis/i.test(key))).toEqual([]);
    expect(off.assets.filter((file) => /Jarvis/i.test(file))).toEqual([]);
    const jarvisJs = off.assets.filter((file) => file.endsWith(".js") && (
      off.read(`assets/${file}`).includes(threadSentinel) || off.read(`assets/${file}`).includes(shellSentinel)
    ));
    expect(jarvisJs).toEqual([]);
    expect(off.read("index.html")).not.toContain("manifest.webmanifest");

    const server = await servePreview(outDir, 4271);
    try {
      const origin = "http://127.0.0.1:4271";
      await page.goto(`${origin}/jarvis`);
      await expect(page.getByText(notFound)).toBeVisible();
      await page.goto(`${origin}/jarvis/`);
      await expect(page.getByText(notFound)).toBeVisible();
      for (const route of ["/", "/quotes", "/parts"]) {
        await page.goto(`${origin}${route}`);
        await expect(page.locator("#root")).not.toBeEmpty();
        await expect(page.getByText(notFound)).toHaveCount(0);
      }
      await expect(page.getByRole("link", { name: "Jarvis" })).toHaveCount(0);
    } finally {
      await server.close();
    }
  });

  test("flag on keeps the shell lazy and follows the server decision", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const outDir = testInfo.outputPath("dist-flag-on");
    const on = await buildApp(outDir, "1");
    const gate = on.manifest["src/pages/JarvisPwaGate.tsx"];
    const shell = on.manifest["src/pages/JarvisPwaShell.tsx"];
    expect(gate?.file).toMatch(/^assets\/JarvisPwaGate-/);
    expect(shell?.file).toMatch(/^assets\/JarvisPwaShell-/);
    expect(gate.dynamicImports).toContain("src/pages/JarvisPwaShell.tsx");
    expect(on.read(shell.file)).toContain(shellSentinel);
    expect(on.read(shell.file)).toContain(threadSentinel);
    for (const file of on.entryClosure) {
      expect(on.read(file)).not.toContain(shellSentinel);
      expect(on.read(file)).not.toContain(threadSentinel);
    }

    const server = await servePreview(outDir, 4272);
    const statuses: number[] = [];
    const requested: string[] = [];
    try {
      const origin = "http://127.0.0.1:4272";
      await page.route("**/api/jarvis/**", async (route) => {
        requested.push(new URL(route.request().url()).pathname);
        await fulfillGate(route, statuses);
      });

      await seedToken(page, null);
      await page.goto(`${origin}/jarvis`);
      await page.waitForURL(/auth=signin/, { timeout: 60_000 });
      expect(statuses).toEqual([401]);

      statuses.length = 0;
      await seedToken(page, NOT_LISTED);
      await page.goto(`${origin}/jarvis`);
      await expect(page.getByText(notFound)).toBeVisible({ timeout: 60_000 });
      expect(statuses).toEqual([404]);
      expect(requested.filter((pathname) => /JarvisPwaShell|JarvisThread/.test(pathname))).toEqual([]);
      await expect(page.locator("[data-jarvis-pwa-shell]")).toHaveCount(0);

      statuses.length = 0;
      await seedToken(page, AAL1);
      await page.goto(`${origin}/jarvis`);
      await expect(page.getByRole("heading", { name: "Confirm it is you" })).toBeVisible({ timeout: 60_000 });
      expect(statuses).toEqual([403]);
      await expect(page.locator("[data-jarvis-pwa-shell]")).toHaveCount(0);

      statuses.length = 0;
      await page.setViewportSize({ width: 390, height: 844 });
      await seedToken(page, AAL2);
      await page.goto(`${origin}/jarvis/`);
      await expect(page.locator("[data-jarvis-pwa-shell]")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/No requests yet/)).toBeVisible();
      expect(statuses).toEqual([200]);
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/jarvis/manifest.webmanifest");
      const manifest = await page.evaluate(async () => {
        const response = await fetch("/jarvis/manifest.webmanifest");
        return response.json() as Promise<{ display: string; icons: { sizes: string }[] }>;
      });
      expect(manifest.display).toBe("standalone");
      expect(manifest.icons.map((icon) => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
      await page.waitForFunction(async () => {
        const registration = await navigator.serviceWorker?.getRegistration("/jarvis/");
        return registration?.scope.endsWith("/jarvis/") ?? false;
      });
      const worker = await page.evaluate(async () => {
        const response = await fetch("/jarvis/sw.js");
        return response.text();
      });
      expect(worker).toContain('addEventListener("fetch"');
      await page.screenshot({ path: testInfo.outputPath("jarvis-pwa-iphone.png"), fullPage: true });
    } finally {
      await server.close();
    }
  });
});
