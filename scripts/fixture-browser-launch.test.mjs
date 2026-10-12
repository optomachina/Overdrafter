// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the actual complete modules, with a closed import boundary. In
// particular, neither Playwright nor the provider kernel is imported or run.
function loadFixtureModule(relativePath, dependencies, env = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    // A neutral extension lets CommonJS transformation also cover .mjs input.
    fileName: "fixture-under-test.ts",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, URL, performance: { now: () => 0 }, process: { env },
    require: (name) => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected fixture dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: relativePath, timeout: 1000 });
  return exports;
}

function warmup(env = {}) {
  const page = { goto: vi.fn().mockResolvedValue(undefined) };
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
  const launch = vi.fn().mockResolvedValue(browser);
  const module = loadFixtureModule("../e2e/fixture-warmup.mjs", { "@playwright/test": { chromium: { launch } } }, env);
  return { ...module, launch, browser, page };
}

describe("fixture warm-up launch contract without a browser", () => {
  it.each([undefined, "false", "true"])("requires sandbox and retains channel selection for CI=%s", async (CI) => {
    const fixture = warmup({ CI });
    fixture.page.goto.mockRejectedValueOnce(new Error("synthetic route failure"));
    await fixture.warmFixtureRoutes("http://127.0.0.1:8080");
    expect(fixture.launch).toHaveBeenCalledExactlyOnceWith({ chromiumSandbox: true, channel: CI === "true" ? "chrome" : undefined });
    expect(fixture.page.goto).toHaveBeenCalledTimes(10);
    for (const [url, options] of fixture.page.goto.mock.calls) {
      expect(new URL(url).origin).toBe("http://127.0.0.1:8080");
      expect(options).toEqual({ waitUntil: "networkidle", timeout: 60_000 });
    }
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it("closes the browser when page setup rejects", async () => {
    const fixture = warmup();
    fixture.browser.newPage.mockRejectedValueOnce(new Error("synthetic page failure"));
    await expect(fixture.warmFixtureRoutes("http://127.0.0.1:8080")).rejects.toThrow("synthetic page failure");
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    expect(fixture.page.goto).not.toHaveBeenCalled();
  });

  it("propagates launch failure without retry or a weaker launch", async () => {
    const fixture = warmup();
    fixture.launch.mockRejectedValueOnce(new Error("synthetic launch failure"));
    await expect(fixture.warmFixtureRoutes("http://127.0.0.1:8080")).rejects.toThrow("synthetic launch failure");
    expect(fixture.launch).toHaveBeenCalledExactlyOnceWith({ chromiumSandbox: true, channel: undefined });
    expect(fixture.browser.close).not.toHaveBeenCalled();
  });
});

function comparison() {
  const directory = path.join("synthetic-temp", "jev-recovery-fixture-owned");
  const fs = { mkdtemp: vi.fn().mockResolvedValue(directory), writeFile: vi.fn().mockResolvedValue(undefined), rm: vi.fn().mockResolvedValue(undefined) };
  const browser = { newContext: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  const launch = vi.fn().mockResolvedValue(browser);
  // The stub invokes the actual launch callback, then models the kernel's
  // ownership of browser cleanup. This does not qualify the real kernel.
  const kernel = vi.fn(async (_definition, _config, _input, hooks) => {
    const launched = await hooks.launchBrowser();
    try { return { state: "offers_extracted" }; }
    finally { await launched.close(); }
  });
  class SyntheticVendorError extends Error {}
  const module = loadFixtureModule("../worker/src/recovery/comparison.ts", {
    "node:fs/promises": fs, "node:os": { tmpdir: () => "synthetic-temp" }, "node:path": path,
    playwright: { chromium: { launch } },
    "../liveEvaluationFiles.js": { authorizeLiveEvaluationInput: async (input) => input, sha256File: async () => "a".repeat(64) },
    "../types.js": { VendorAutomationError: SyntheticVendorError },
    "../adapters/providerPortalKernel.js": { buildExpectedProviderPortalApproval: () => ({}), runProviderPortalKernel: kernel },
    "./jevDecision.js": { JEV_RECOVERY_MODEL: "synthetic-unused-model" },
  });
  return { ...module, directory, fs, browser, launch, kernel };
}

describe("recovery comparison launch contract without a browser", () => {
  it("passes sandbox and the original timeout through the actual injected launcher", async () => {
    const fixture = comparison();
    await expect(fixture.runComparisonCase("stable")).resolves.toMatchObject({ completed: true, calls: 0, uploadAttempts: 0 });
    expect(fixture.launch).toHaveBeenCalledExactlyOnceWith({ chromiumSandbox: true, timeout: 10_000 });
    expect(fixture.browser.close).toHaveBeenCalledOnce();
    expect(fixture.fs.rm).toHaveBeenCalledExactlyOnceWith(fixture.directory, { recursive: true, force: true });
  });

  it("cleans its temporary fixture after launch rejection without retry or fallback", async () => {
    const fixture = comparison();
    fixture.launch.mockRejectedValueOnce(new Error("synthetic launch failure"));
    await expect(fixture.runComparisonCase("stable")).rejects.toThrow("synthetic launch failure");
    expect(fixture.launch).toHaveBeenCalledExactlyOnceWith({ chromiumSandbox: true, timeout: 10_000 });
    expect(fixture.browser.close).not.toHaveBeenCalled();
    expect(fixture.fs.rm).toHaveBeenCalledExactlyOnceWith(fixture.directory, { recursive: true, force: true });
  });

  it("preserves cleanup and the original error when the kernel rejects", async () => {
    const fixture = comparison();
    fixture.kernel.mockRejectedValueOnce(new Error("synthetic kernel failure"));
    await expect(fixture.runComparisonCase("stable")).rejects.toThrow("synthetic kernel failure");
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(fixture.fs.rm).toHaveBeenCalledExactlyOnceWith(fixture.directory, { recursive: true, force: true });
  });
});
