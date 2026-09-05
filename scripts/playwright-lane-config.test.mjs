// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const configPath = fileURLToPath(new URL("../playwright.config.ts", import.meta.url));
const setupPath = fileURLToPath(new URL("../e2e/global-setup.mjs", import.meta.url));

/** Evaluate real lane modules with explicit environment and inert dependencies. */
function loadModule(sourcePath, env, dependencies) {
  const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = {
    exports: {},
    process: { env: { ...env } },
    require(specifier) {
      if (!Object.hasOwn(dependencies, specifier)) {
        throw new Error(`Unexpected lane dependency: ${specifier}`);
      }
      return dependencies[specifier];
    },
  };
  runInNewContext(compiled, sandbox, { filename: sourcePath, timeout: 1000 });
  return sandbox.exports.default;
}

function loadConfig(env = {}) {
  return loadModule(configPath, env, { "@playwright/test": { defineConfig: (value) => value } });
}

function loadSetup(env, ensureAuthStates) {
  return loadModule(setupPath, env, { "./auth.mjs": { ensureAuthStates } });
}

describe("Playwright execution lane configuration", () => {
  it.each([
    { caseName: "locally", ci: undefined },
    { caseName: "in CI", ci: "true" },
  ])("isolates the fixture lane $caseName from ambient hosted targets", ({ ci }) => {
    const config = loadConfig({
      CI: ci,
      PLAYWRIGHT_SKIP_AUTH_SETUP: "1",
      PLAYWRIGHT_BASE_URL: "https://must-not-use.example",
      VITE_SUPABASE_URL: "https://must-not-use.example",
      VITE_SUPABASE_PUBLISHABLE_KEY: "must-not-use-key",
    });

    expect(config.use.baseURL).toBe("http://127.0.0.1:4173");
    expect(config.webServer.url).toBe(config.use.baseURL);
    expect(config.webServer.command).toBe("npm run dev -- --host 127.0.0.1 --port 4173");
    expect(config.webServer.reuseExistingServer).toBe(false);
    expect(config.webServer.env.VITE_ENABLE_FIXTURE_MODE).toBe("1");
    expect(config.webServer.env.VITE_SUPABASE_URL).toBe("http://127.0.0.1:9");
    expect(config.webServer.env.VITE_SUPABASE_PUBLISHABLE_KEY).not.toBe("must-not-use-key");
    const publicKeyClaims = JSON.parse(
      Buffer.from(config.webServer.env.VITE_SUPABASE_PUBLISHABLE_KEY.split(".")[1], "base64url")
        .toString("utf8"),
    );
    expect(publicKeyClaims).toMatchObject({ iss: "supabase-demo", role: "anon" });
    expect(config.use.launchOptions.args).toEqual([
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ]);
    expect(config.use.storageState).toBeUndefined();
  });

  it("skips real auth-state preparation for the fixture lane", async () => {
    const env = { PLAYWRIGHT_SKIP_AUTH_SETUP: "1" };
    const ensureAuthStates = vi.fn().mockResolvedValue(undefined);
    expect(loadConfig(env).globalSetup).toBe("./e2e/global-setup.mjs");
    await loadSetup(env, ensureAuthStates)();
    expect(ensureAuthStates).not.toHaveBeenCalled();
  });

  it("preserves explicit authenticated backend and app overrides", async () => {
    const env = {
      PLAYWRIGHT_BASE_URL: "http://127.0.0.1:4174",
      VITE_SUPABASE_URL: "http://127.0.0.1:54322",
      VITE_SUPABASE_PUBLISHABLE_KEY: "explicit-local-test-key",
    };
    const config = loadConfig(env);
    expect(config.use.baseURL).toBe(env.PLAYWRIGHT_BASE_URL);
    expect(config.webServer.url).toBe(env.PLAYWRIGHT_BASE_URL);
    expect(config.webServer.env.VITE_SUPABASE_URL).toBe(env.VITE_SUPABASE_URL);
    expect(config.webServer.env.VITE_SUPABASE_PUBLISHABLE_KEY)
      .toBe(env.VITE_SUPABASE_PUBLISHABLE_KEY);
    expect(config.webServer.reuseExistingServer).toBe(true);
    expect(config.use.launchOptions).toBeUndefined();
    const ensureAuthStates = vi.fn().mockResolvedValue(undefined);
    await loadSetup(env, ensureAuthStates)();
    expect(ensureAuthStates).toHaveBeenCalledOnce();
  });

  it("defaults to authenticated local setup when the fixture flag is absent", async () => {
    const config = loadConfig();
    expect(config.use.baseURL).toBe("http://127.0.0.1:4173");
    expect(config.webServer.env.VITE_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(config.webServer.reuseExistingServer).toBe(true);
    expect(config.use.launchOptions).toBeUndefined();
    const ensureAuthStates = vi.fn().mockResolvedValue(undefined);
    await loadSetup({}, ensureAuthStates)();
    expect(ensureAuthStates).toHaveBeenCalledOnce();
  });

  it.each(["0", "true", ""])("does not skip authenticated setup for flag %j", async (flag) => {
    const env = { PLAYWRIGHT_SKIP_AUTH_SETUP: flag };
    const config = loadConfig(env);
    expect(config.webServer.env.VITE_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(config.use.launchOptions).toBeUndefined();
    const ensureAuthStates = vi.fn().mockResolvedValue(undefined);
    await loadSetup(env, ensureAuthStates)();
    expect(ensureAuthStates).toHaveBeenCalledOnce();
  });

  it("also requires a fresh server for authenticated CI runs", () => {
    expect(loadConfig({ CI: "true" }).webServer.reuseExistingServer).toBe(false);
  });

  it("installs browser CI dependencies without lifecycle scripts or package runners", () => {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const lines = ci.split("\n");
    const jobStart = lines.indexOf("  browser-test:");
    expect(jobStart).toBeGreaterThan(-1);
    const nextJobStart = lines.findIndex((line, index) => (
      index > jobStart && line.startsWith("  ") && !line.startsWith("   ") && line.endsWith(":")
    ));
    expect(nextJobStart).toBeGreaterThan(jobStart);
    const browserJob = lines.slice(jobStart, nextJobStart).join("\n");

    expect(browserJob).toContain(
      "- name: Install root dependencies\n        run: npm ci --ignore-scripts\n",
    );
    expect(browserJob).toContain(
      "- name: Install Chromium\n        run: node ./node_modules/playwright/cli.js install --with-deps chromium\n",
    );
    expect(browserJob).not.toContain("run: npx ");
    expect(browserJob).not.toContain("run: npm exec ");
  });

  it("wires both explicit lanes into the required CI job", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.e2e).toBe("npm run e2e:authenticated");
    expect(pkg.scripts["e2e:fixture"]).toBe(
      "PLAYWRIGHT_SKIP_AUTH_SETUP=1 playwright test --grep @fixture",
    );
    expect(pkg.scripts["e2e:authenticated"]).toBe("playwright test --grep-invert @fixture");
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).toContain("run: npm run e2e:fixture");
    expect(ci).toContain("run: npm run e2e:authenticated");
    expect(ci).toContain("needs.browser-test.result");
    expect(ci).toContain('[ "$BROWSER_TEST_RESULT" != "success" ]');
    expect(ci).toContain("needs.ovd420-recovery-egress-network.result");
  });
});
