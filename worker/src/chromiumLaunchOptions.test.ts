// @vitest-environment node

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromiumSandboxLaunchOptions } from "./chromiumLaunchOptions";

// Service and job launchers that honor PLAYWRIGHT_DISABLE_SANDBOX.
const DEPLOYED_CHROMIUM_LAUNCHERS = [
  "adapters/fictiv.ts",
  "adapters/providerPortalKernel.ts",
  "adapters/xometry.ts",
  "tools/probeXometryProfileAuth.ts",
];

// The headed operator auth tools and the synthetic browser-recovery comparison
// harness ignore PLAYWRIGHT_DISABLE_SANDBOX, so Playwright launches them with
// --no-sandbox. Whether they should request the sandbox is decided in OVD-610.
// Changing this list also needs the worker README exception list updated.
const UNSANDBOXED_OPERATOR_LAUNCHERS = [
  "recovery/comparison.ts",
  "tools/fictivAuth.ts",
  "tools/vendorAuth.ts",
  "tools/xometryAuth.ts",
];

const BROWSER_PACKAGE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'](?:playwright|patchright|playwright-core)["']/g;

/** True when the source has a value import of `chromium` from a browser package. */
function importsChromium(source: string): boolean {
  return [...source.matchAll(BROWSER_PACKAGE_IMPORT)].some(([, specifiers]) =>
    specifiers.split(",").some((specifier) => /^chromium\b/.test(specifier.trim())),
  );
}

describe("chromiumSandboxLaunchOptions", () => {
  it("requests the Chromium sandbox explicitly unless it is disabled", () => {
    expect(chromiumSandboxLaunchOptions({
      playwrightDisableSandbox: false,
      playwrightDisableDevShmUsage: false,
    })).toEqual({ args: [], chromiumSandbox: true });
    expect(chromiumSandboxLaunchOptions({
      playwrightDisableSandbox: false,
      playwrightDisableDevShmUsage: true,
    })).toEqual({ args: ["--disable-dev-shm-usage"], chromiumSandbox: true });
  });

  it("keeps the explicit opt-out flags when PLAYWRIGHT_DISABLE_SANDBOX is set", () => {
    expect(chromiumSandboxLaunchOptions({
      playwrightDisableSandbox: true,
      playwrightDisableDevShmUsage: true,
    })).toEqual({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      chromiumSandbox: false,
    });
  });

  it("routes every source that imports Chromium through the helper, except the listed operator launchers", async () => {
    // Playwright adds --no-sandbox whenever chromiumSandbox is not true, so a
    // Chromium launcher that skips the helper, or builds its own args, silently
    // keeps the sandbox off. This check works per file, from imports; the
    // per-launcher tests check what each call site passes.
    const sources = (await fs.readdir(import.meta.dirname, { recursive: true }))
      .filter((relative) => relative.endsWith(".ts") && !relative.endsWith(".test.ts"))
      .sort();
    const chromiumImporters: string[] = [];
    const withoutHelper: string[] = [];
    const handBuilt: string[] = [];
    for (const relative of sources) {
      const source = await fs.readFile(path.join(import.meta.dirname, relative), "utf8");
      if (relative !== "chromiumLaunchOptions.ts" && source.includes("\"--no-sandbox\"")) {
        handBuilt.push(relative);
      }
      if (!importsChromium(source)) continue;
      chromiumImporters.push(relative);
      if (!source.includes("chromiumSandboxLaunchOptions(")) withoutHelper.push(relative);
    }
    expect(chromiumImporters).toEqual(expect.arrayContaining(DEPLOYED_CHROMIUM_LAUNCHERS));
    expect(withoutHelper).toEqual(UNSANDBOXED_OPERATOR_LAUNCHERS);
    expect(handBuilt).toEqual([]);
  });
});
