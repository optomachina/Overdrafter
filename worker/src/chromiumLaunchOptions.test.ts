// @vitest-environment node

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromiumSandboxLaunchOptions } from "./chromiumLaunchOptions";

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

  it("is the only place worker sources decide the Chromium sandbox", async () => {
    // Playwright adds --no-sandbox whenever chromiumSandbox is not true, so a
    // launcher that builds its own args would silently keep the sandbox off.
    for (const launcher of [
      "adapters/xometry.ts",
      "adapters/fictiv.ts",
      "adapters/providerPortalKernel.ts",
      "tools/probeXometryProfileAuth.ts",
    ]) {
      const source = await fs.readFile(path.join(import.meta.dirname, launcher), "utf8");
      expect(source, launcher).toContain("chromiumSandboxLaunchOptions(");
    }
    const sources = await fs.readdir(import.meta.dirname, { recursive: true });
    const handBuilt = [];
    for (const relative of sources) {
      if (!relative.endsWith(".ts") || relative.endsWith(".test.ts") || relative === "chromiumLaunchOptions.ts") continue;
      const source = await fs.readFile(path.join(import.meta.dirname, relative), "utf8");
      if (source.includes("\"--no-sandbox\"")) handBuilt.push(relative);
    }
    expect(handBuilt).toEqual([]);
  });
});
