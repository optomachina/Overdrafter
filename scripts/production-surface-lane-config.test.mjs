// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const configPath = fileURLToPath(new URL("../e2e/production-surface.config.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Evaluate the real lane config with an explicit environment and inert dependencies. */
function loadConfig(env = {}) {
  const compiled = ts.transpileModule(readFileSync(configPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dependencies = {
    "@playwright/test": { defineConfig: (value) => value },
    "node:url": { fileURLToPath },
  };
  const sandbox = {
    exports: {},
    URL,
    process: { env: { ...env } },
    require(specifier) {
      if (!Object.hasOwn(dependencies, specifier)) throw new Error(`Unexpected lane dependency: ${specifier}`);
      return dependencies[specifier];
    },
  };
  runInNewContext(compiled.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(configPath).href)), sandbox, { filename: configPath, timeout: 1000 });
  return sandbox.exports.default ?? sandbox.exports;
}

function jobBlock(ci, job) {
  const lines = ci.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S.*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function stepNames(block) {
  return [...block.matchAll(/^ {6}- name: (.+)$/gm)].map((match) => match[1]);
}

describe("production-surface Playwright lane configuration", () => {
  it.each([{}, { CI: "true" }])("serves only the dedicated spec over loopback with sandboxed Chromium for %j", (env) => {
    const config = loadConfig(env);
    expect(config.testDir).toBe(".");
    expect(config.testMatch).toBe("production-surface.browser.ts");
    expect(config.globalSetup).toBeUndefined();
    expect(config.use.baseURL).toBe("http://127.0.0.1:4176");
    expect(config.use.storageState).toBeUndefined();
    expect(config.use.launchOptions).toEqual({ chromiumSandbox: true });
    expect(config.use.channel).toBe(env.CI === "true" ? "chrome" : undefined);
    expect(config.webServer.reuseExistingServer).toBe(false);
    expect(config.webServer.url).toBe("http://127.0.0.1:4176/legal/terms");
    expect(config.webServer.cwd.replace(/\/$/, "")).toBe(repoRoot.replace(/\/$/, ""));
  });

  it("builds a production bundle into output/playwright/ and previews exactly that bundle", () => {
    const { command } = loadConfig().webServer;
    const [build, preview, ...rest] = command.split(" && ");
    expect(rest).toEqual([]);
    expect(build).toBe("node node_modules/vite/bin/vite.js build --mode production --outDir output/playwright/production-surface-dist");
    expect(preview).toBe(
      "node node_modules/vite/bin/vite.js preview --outDir output/playwright/production-surface-dist --host 127.0.0.1 --port 4176 --strictPort",
    );
  });

  it("pins a production, fixture-free, offline build environment over ambient values", () => {
    // Playwright merges process.env first and webServer.env last, so these keys always win.
    const { env } = loadConfig({
      NODE_ENV: "development",
      VITE_ENABLE_FIXTURE_MODE: "1",
      VITE_ENABLE_ENGINEERING_WORKBENCH: "1",
      VITE_SUPABASE_URL: "https://must-not-use.example",
      VITE_SUPABASE_PUBLISHABLE_KEY: "must-not-use-key",
    }).webServer;
    expect(env).toMatchObject({
      NODE_ENV: "production",
      VITE_ENABLE_FIXTURE_MODE: "0",
      VITE_ENABLE_ENGINEERING_WORKBENCH: "0",
      OVD_SAMPLE_PLATE_DEMO_ENABLED: "0",
      VITE_SUPABASE_URL: "http://127.0.0.1:9",
    });
    const claims = JSON.parse(Buffer.from(env.VITE_SUPABASE_PUBLISHABLE_KEY.split(".")[1], "base64url").toString("utf8"));
    expect(claims).toMatchObject({ iss: "supabase-demo", role: "anon" });
  });

  it("is reachable through the npm script and both CI jobs", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["e2e:production-surface"]).toBe("playwright test --config e2e/production-surface.config.ts");

    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const browserJob = jobBlock(ci, "browser-test");
    const browserSteps = stepNames(browserJob);
    expect(browserSteps[browserSteps.indexOf("Test fixture browser workflows") + 1]).toBe("Test production build surface");
    expect(browserJob).toContain("- name: Test production build surface\n        run: npm run e2e:production-surface\n");

    const buildJob = jobBlock(ci, "build");
    const buildSteps = stepNames(buildJob);
    expect(buildSteps[buildSteps.indexOf("Build app") + 1]).toBe("Verify production bundle exclusions");
    expect(buildJob).toContain(
      "- name: Verify production bundle exclusions\n        run: node scripts/verify-production-bundle-exclusions.mjs dist\n",
    );
  });
});
