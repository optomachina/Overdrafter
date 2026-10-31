// @vitest-environment node

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

const configPath = fileURLToPath(new URL("../playwright.config.ts", import.meta.url));
const setupPath = fileURLToPath(new URL("../e2e/global-setup.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const playwrightStub = { defineConfig: value => value };
const configDependencies = {
  "@playwright/test": playwrightStub,
  "playwright/test": playwrightStub,
  "node:url": { fileURLToPath },
};

function commandConfigs(command) {
  // Read only Playwright invocations, excluding Vite, Deno and scanner --config flags.
  return command.replace(/\\\r?\n/g, " ").split(/&&|\|\||[;\n]/).flatMap(part => {
    const args = part.match(/\bplaywright(?:\/cli\.js)?["']?\s+test\b(.*)/)?.[1];
    return [...(args ?? "").matchAll(/--config(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))/g)]
      .map(match => match[1] ?? match[2] ?? match[3]);
  });
}

function referencedConfigs(trackedFiles) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const commands = Object.values(pkg.scripts);
  for (const file of trackedFiles.filter(file => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file))) {
    const workflow = parseYaml(readFileSync(path.join(repoRoot, file), "utf8"));
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) if (typeof step.run === "string") commands.push(step.run);
    }
  }
  // Evaluate the registry with inert imports too; never launch its CLI or a browser.
  const registry = loadModule(path.join(repoRoot, ".agents/skills/verify-overdrafter/scripts/feature-specs.mjs"), {}, {
    "node:url": { fileURLToPath },
  });
  const required = new Set([
    "playwright.config.ts", ...commands.flatMap(commandConfigs), registry.DEFAULT_CONFIG,
    ...Object.keys(registry.CONFIG_PORTS), ...Object.keys(registry.CONFIG_TEST_DIRS),
  ]);
  function collectSpecs(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.config === "string") required.add(value.config);
    for (const child of Object.values(value)) collectSpecs(child);
  }
  collectSpecs(registry.FEATURE_SPECS);
  collectSpecs(registry.PENDING_SPECS);
  return new Set([...required].map(file => path.posix.normalize(file)));
}

function isPlaywrightConfig(file, source) {
  if (!source.includes("playwright/test")) return false;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  let importsPlaywright = false;
  let exportsConfig = false;
  function visit(node) {
    if (ts.isImportDeclaration(node) && ["@playwright/test", "playwright/test"].includes(node.moduleSpecifier.text)) {
      importsPlaywright = true;
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "require"
      && ["@playwright/test", "playwright/test"].includes(node.arguments[0]?.text)) importsPlaywright = true;
    if (ts.isExportAssignment(node)) exportsConfig = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ["module.exports", "exports.default"].includes(node.left.getText(ast))) exportsConfig = true;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return importsPlaywright && exportsConfig;
}

function findPlaywrightConfigs(trackedFiles, required) {
  return trackedFiles.filter(file => /\.[cm]?[jt]sx?$/.test(file)).filter(file => (
    required.has(file) || isPlaywrightConfig(file, readFileSync(path.join(repoRoot, file), "utf8"))
  ));
}

/** Evaluate real lane modules with explicit environment and inert dependencies. */
function loadModule(sourcePath, env, dependencies) {
  return evaluateModule(readFileSync(sourcePath, "utf8"), sourcePath, env, dependencies);
}

function evaluateModule(source, sourcePath, env, dependencies) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    URL,
    process: { env: { ...env }, argv: [] },
    require(specifier) {
      if (!Object.hasOwn(dependencies, specifier)) {
        throw new Error(`Unexpected lane dependency: ${specifier}`);
      }
      return dependencies[specifier];
    },
  };
  runInNewContext(compiled.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(sourcePath).href)), sandbox, { filename: sourcePath, timeout: 1000 });
  return module.exports.default ?? module.exports;
}

function loadConfig(env = {}) {
  return loadModule(configPath, env, { "@playwright/test": { defineConfig: (value) => value } });
}

function loadSetup(env, ensureAuthStates, warmFixtureRoutes = vi.fn().mockResolvedValue(undefined)) {
  return loadModule(setupPath, env, {
    "./auth.mjs": { ensureAuthStates },
    "./fixture-warmup.mjs": { warmFixtureRoutes },
  });
}

describe("Playwright execution lane configuration", () => {
  it.each([{}, { CI: "true" }])("forbids focused tests only in CI across all tracked configs for %j", env => {
    const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0");
    const required = referencedConfigs(trackedFiles);
    const configs = findPlaywrightConfigs(trackedFiles, required);
    for (const file of required) expect(configs, `Referenced Playwright config not discovered: ${file}`).toContain(file);
    for (const file of configs) {
      const config = loadModule(path.join(repoRoot, file), env, configDependencies);
      expect(config.forbidOnly, file).toBe(!!env.CI);
    }
  });

  it.each([
    'import { defineConfig } from "playwright/test"; export default defineConfig({ forbidOnly: !!process.env.CI });',
    'import type { PlaywrightTestConfig } from "@playwright/test"; const config: PlaywrightTestConfig = { forbidOnly: !!process.env.CI }; export default config;',
    'import * as pw from "@playwright/test"; export default pw.defineConfig({ forbidOnly: !!process.env.CI });',
    'const pw = require("playwright/test"); module.exports = pw.defineConfig({ forbidOnly: !!process.env.CI });',
  ])("discovers alternate config syntax and evaluates it without real imports: %s", source => {
    expect(isPlaywrightConfig("lane.ts", source)).toBe(true);
    for (const env of [{}, { CI: "true" }]) {
      expect(evaluateModule(source, configPath, env, configDependencies).forbidOnly).toBe(!!env.CI);
    }
  });

  it.each([
    ["lane.mjs", "export default { forbidOnly: !!process.env.CI };"],
    ["lane.cjs", "module.exports = { forbidOnly: !!process.env.CI };"],
  ])("includes and evaluates import-free referenced configs: %s", (file, source) => {
    expect(findPlaywrightConfigs([file], new Set([file]))).toEqual([file]);
    for (const env of [{}, { CI: "true" }]) {
      expect(evaluateModule(source, path.join(repoRoot, file), env, configDependencies).forbidOnly).toBe(!!env.CI);
    }
  });

  it("extracts quoted, equals and multiline config arguments only from Playwright commands", () => {
    expect(commandConfigs('vite build --config vite.config.ts && playwright test --config="e2e/new lane.mjs"\nnode ./node_modules/playwright/cli.js test \\\n --config lane.cjs')).toEqual(["e2e/new lane.mjs", "lane.cjs"]);
  });

  it("rejects unstubbed dependencies instead of executing config side effects", () => {
    expect(() => evaluateModule('require("node:child_process").execSync("unexpected");', configPath, {}, configDependencies))
      .toThrow("Unexpected lane dependency: node:child_process");
  });

  it.each([{}, { CI: "true" }])("retains sandboxed auth-setup launches for %j", async env => {
    const page = {
      goto: vi.fn(),
      locator: () => ({ fill: vi.fn(), getByRole: () => ({ click: vi.fn() }) }),
      getByRole: () => ({ waitFor: vi.fn() }), getByText: () => ({ waitFor: vi.fn() }),
      context: () => ({ storageState: vi.fn() }),
    };
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
    const launch = vi.fn().mockResolvedValue(browser);
    const module = loadModule(fileURLToPath(new URL("../e2e/auth.mjs", import.meta.url)), env, {
      "@playwright/test": { chromium: { launch } },
      "node:fs/promises": { mkdir: vi.fn() }, "node:path": { default: path },
      "node:url": { fileURLToPath },
    });
    await module.ensureAuthStates();
    expect(launch).toHaveBeenCalledTimes(2);
    for (const [options] of launch.mock.calls) expect(options).toEqual({
      headless: true, chromiumSandbox: true, channel: env.CI === "true" ? "chrome" : undefined,
    });
    expect(browser.close).toHaveBeenCalledTimes(2);
  });

  it("selects installed Chrome while retaining the sandbox for authenticated CI", () => {
    const config = loadConfig({ CI: "true" });
    expect(config.use.channel).toBe("chrome");
    expect(config.use.launchOptions).toEqual({ chromiumSandbox: true });
  });

  it.each([
    { env: {}, channel: undefined, executablePath: undefined },
    { env: { CI: "true" }, channel: "chrome", executablePath: undefined },
    { env: { CI: "true", ADMIN_TEST_CHROMIUM: "/fixture/explicit-chrome" }, channel: undefined, executablePath: "/fixture/explicit-chrome" },
  ])("keeps admin sandboxing and explicit browser selection for $env", ({ env, channel, executablePath }) => {
    const path = fileURLToPath(new URL("../e2e/admin-operations.config.ts", import.meta.url));
    const config = loadModule(path, env, {
      "@playwright/test": { defineConfig: value => value },
      "node:url": { fileURLToPath },
    });
    expect(config.use.channel).toBe(channel);
    expect(config.use.launchOptions.chromiumSandbox).toBe(true);
    expect(config.use.launchOptions.executablePath).toBe(executablePath);
    expect(config.use.launchOptions.args).toBeUndefined();
  });

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

    expect(config.expect.timeout).toBe(15_000);
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
    expect(config.use.launchOptions.chromiumSandbox).toBe(true);
    expect(config.use.channel).toBe(ci === "true" ? "chrome" : undefined);
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
    const warmFixtureRoutes = vi.fn().mockResolvedValue(undefined);
    await loadSetup(env, ensureAuthStates, warmFixtureRoutes)();
    expect(ensureAuthStates).not.toHaveBeenCalled();
    expect(warmFixtureRoutes).toHaveBeenCalledWith("http://127.0.0.1:4173");
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
    expect(config.use.launchOptions).toEqual({ chromiumSandbox: true });
    const ensureAuthStates = vi.fn().mockResolvedValue(undefined);
    await loadSetup(env, ensureAuthStates)();
    expect(ensureAuthStates).toHaveBeenCalledOnce();
  });

  it("defaults to authenticated local setup when the fixture flag is absent", async () => {
    const config = loadConfig();
    expect(config.use.baseURL).toBe("http://127.0.0.1:4173");
    expect(config.webServer.env.VITE_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(config.webServer.reuseExistingServer).toBe(true);
    expect(config.use.launchOptions).toEqual({ chromiumSandbox: true });
    const ensureAuthStates = vi.fn().mockResolvedValue(undefined);
    await loadSetup({}, ensureAuthStates)();
    expect(ensureAuthStates).toHaveBeenCalledOnce();
  });

  it.each(["0", "true", ""])("does not skip authenticated setup for flag %j", async (flag) => {
    const env = { PLAYWRIGHT_SKIP_AUTH_SETUP: flag };
    const config = loadConfig(env);
    expect(config.webServer.env.VITE_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(config.use.launchOptions).toEqual({ chromiumSandbox: true });
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

    // Root dependencies come from the shared action: npm ci without lifecycle
    // scripts, or a node_modules cache that only main saves from that same install.
    expect(browserJob).toContain(
      "- name: Setup Node.js and install root dependencies\n        uses: ./.github/actions/setup-root-dependencies\n",
    );
    const setupAction = readFileSync(new URL("../.github/actions/setup-root-dependencies/action.yml", import.meta.url), "utf8");
    expect(setupAction).toContain("- name: Install root dependencies\n      if: ${{ steps.node-modules.outputs.cache-hit != 'true' }}\n      shell: bash\n      run: npm ci --ignore-scripts\n");
    // Every install command (the cache miss and the stale-restore fallback) skips scripts.
    expect(setupAction.match(/^\s+(?:run: )?npm (?:ci|install|i)\b.*$/gm)?.map(line => line.trim())).toEqual([
      "run: npm ci --ignore-scripts",
      "npm ci --ignore-scripts",
    ]);
    expect(setupAction).toContain("-ignore-scripts-${{ hashFiles('package-lock.json') }}");
    expect(setupAction).not.toContain("npx ");
    expect(setupAction).not.toContain("npm exec ");
    expect(browserJob).toContain(
      "- name: Install Chromium\n        run: node ./node_modules/playwright/cli.js install --with-deps chromium\n",
    );
    expect(browserJob).toContain("test -x /opt/google/chrome/chrome && /opt/google/chrome/chrome --version");
    expect(browserJob).not.toContain("--no-sandbox");
    expect(browserJob).not.toContain("sysctl");
    expect(browserJob).not.toContain("run: npx ");
    expect(browserJob).not.toContain("run: npm exec ");
  });

  it.each(["admin-operations", "quote-confirmation"])("uploads the cwd-relative JSON report and test output for %s", lane => {
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const browserJob = ci.split("  browser-test:")[1].split("\n  build:")[0];
    const steps = browserJob.split("      - name:");
    const testStep = steps.find(step => step.includes(`--output=${lane}-results `));
    const uploadStep = steps.find(step => step.includes(`name: ${lane}-browser-evidence`));
    expect(testStep).toBeDefined();
    expect(uploadStep).toBeDefined();
    const uploadPath = uploadStep.match(/path: ([^\s]+)\//)[1];
    // OUTPUT_NAME defaults to configDir; OUTPUT_FILE and --output resolve from cwd.
    expect(testStep).toContain(`PLAYWRIGHT_JSON_OUTPUT_FILE: ${uploadPath}/report.json`);
    expect(testStep).not.toContain("PLAYWRIGHT_JSON_OUTPUT_NAME:");
    expect(testStep).toContain(`--output=${uploadPath} --reporter=line,json`);
    expect(uploadStep).toContain("uses: actions/upload-artifact@v4");
    expect(uploadStep).toContain("always() && matrix.lane == 'synthetic'");
  });

  it("wires both explicit lanes into the required CI job", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.e2e).toBe("npm run e2e:authenticated");
    // The OVD-571 delivered-comparison spec needs its synthetic-only server, so
    // the fixture lane runs its config after the main fixture suite.
    expect(pkg.scripts["e2e:fixture"]).toBe(
      "PLAYWRIGHT_SKIP_AUTH_SETUP=1 playwright test --grep @fixture"
        + " && playwright test --config e2e/delivered-comparison.config.ts",
    );
    expect(loadConfig().testIgnore).toEqual(["delivered-comparison.spec.ts"]);
    expect(pkg.scripts["e2e:authenticated"]).toBe("playwright test --grep-invert @fixture");
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).toContain("run: npm run e2e:fixture");
    expect(ci).toContain("run: npm run e2e:authenticated");
    expect(ci).toContain("needs.browser-test.result");
    expect(ci).toContain('[ "$BROWSER_TEST_RESULT" != "success" ]');
    expect(ci).toContain("needs.ovd420-recovery-egress-network.result");
  });
});
