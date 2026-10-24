// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const quoteSuite = "scripts/api-request-quote.test.mjs";
const liveSuite = "worker/src/adapters/fictiv.live.test.ts";
const portableSuites = [
  "scripts/catalog-parity-diff.node-test.mjs",
  "scripts/prepare-sourcing-schema-restore.node-test.mjs",
  "scripts/native/runner-containment/closed-journal.node-test.mjs",
  "scripts/migration-timestamp.node-test.mjs",
  "scripts/stripe-catalog-setup.node-test.mjs",
  "scripts/verify-migration-lineage.node-test.mjs",
  "scripts/provider-permissions-verify.node-test.mjs",
  "tools/guardrails/proposed/guard-migrations.node-test.mjs",
  "scripts/window2-packet.node-test.mjs",
  "scripts/lint-rls-new-tables.node-test.mjs",
  "scripts/sensitive-paths-report.node-test.mjs",
  "scripts/check-migration-immutability.node-test.mjs",
  "scripts/check-secret-paths.node-test.mjs",
  "scripts/check-migration-function-collisions.node-test.mjs",
  "scripts/ovd510-boundary-recovery.node-test.mjs",
  "scripts/ovd510-immutable-source.node-test.mjs",
  "scripts/test-support/source-only-network-marker.node-test.cjs",
];

// Operator-run historical build replay, not a portable Node 20 suite. Preserve
// its assertions: it needs Node 22 type stripping and the pinned revision's npm
// cache. The exact command/prerequisites live in scripts/fixtures/compiled-worker-scope.md.
const manuallyRunNodeSuites = {
  "scripts/check-compiled-worker-scope.node-test.mjs": "scripts/fixtures/compiled-worker-scope.md",
  // Transport probes remain execution-review-blocked per this README; the
  // filesystem-only marker suite is independently owned by the portable lane.
  "scripts/test-support/source-only-network.node-test.cjs": "scripts/test-support/README.md",
};

// Discovery must not impose a shell-token naming restriction on tracked paths.
const nodeSuite = /\.node-test\.[cm]?js$/;

// Deliberately recognize simple, failure-propagating invocations, not arbitrary
// shell programs. Unsupported wrappers/control flow need an explicit lane.
function requiredCommands(source, npmScript = false) {
  const active = source.replace(/\\\r?\n/g, " ").trim();
  const lines = active.split(/\r?\n/);
  // One AND-list returns its failing status. Multiple lines require workflow
  // errexit and must contain no AND-lists (errexit ignores their non-final terms).
  if (lines.length > 1 && (npmScript || active.includes("&&"))) return [];
  const word = String.raw`(?:[\w./:+-]+|"[\w ./:+*-]+"|'[\w ./:+*-]+')`;
  const command = new RegExp(`^(?:node|npm|python3|echo)(?:[ \\t]+${word})*$`);
  const commands = lines.flatMap((line) => line.split("&&").map((part) => part.trim()));
  // Validate the WHOLE body before counting anything. No control flow,
  // substitutions, comments, redirects, assignments or shell-state changes.
  if (!commands.length || !commands.every((part) => command.test(part))) return [];
  return commands.map((part) => (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^(["'])(.*)\1$/, "$2")));
}

function countedWorkflowCommands(source) {
  const workflow = parse(source);
  const enabled = (entry) => (entry.if === undefined || entry.if === true
    || /^\$\{\{\s*true\s*\}\}$/.test(entry.if))
    && (entry["continue-on-error"] === undefined || entry["continue-on-error"] === false);
  return Object.values(workflow?.jobs ?? {}).flatMap((job) => !enabled(job) ? []
    : (job.steps ?? []).filter((step) => enabled(step) && typeof step.run === "string")
      .flatMap((step) => {
        const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell
          ?? (/^(ubuntu|macos)-[\w.-]+$/.test(job["runs-on"]) ? "bash" : undefined);
        let source = step.run;
        if (shell === "powershell" || shell === "pwsh") {
          // The existing Windows lane has exactly one native command followed
          // by an explicit exit-code handoff, not arbitrary PowerShell code.
          const match = source.trim().match(/^(node[^\r\n]*)\r?\n[ \t]*exit \$LASTEXITCODE$/);
          if (!match || match[1].includes("&&")) return [];
          source = match[1];
        } else if (shell !== "bash" && shell !== "sh") return [];
        return [{
          source,
          cwd: step["working-directory"] ?? job.defaults?.run?.["working-directory"]
            ?? workflow.defaults?.run?.["working-directory"] ?? ".",
        }];
      }));
}

function runnerReferences(manifests, workflows) {
  const references = new Set();
  const visited = new Set();
  function visitScript(cwd, name) {
    const key = `${cwd}:${name}`;
    if (visited.has(key)) return;
    visited.add(key);
    const source = manifests[posix.join(cwd, "package.json")]?.scripts?.[name];
    if (typeof source === "string") visitCommands(source, cwd, true);
  }
  function visitCommands(source, cwd, npmScript = false) {
    if (typeof cwd !== "string" || !/^[\w ./+-]+$/.test(cwd)) return;
    for (const raw of requiredCommands(source, npmScript)) {
      const tokens = [...raw];
      const executable = tokens.shift();
      if (executable === "node") {
        const testRunner = tokens.includes("--test");
        while (["--test", "--experimental-strip-types"].includes(tokens[0])) tokens.shift();
        // With plain node only the entrypoint runs; later arguments are data.
        const suites = testRunner ? tokens : tokens.slice(0, 1);
        if (suites.length && suites.every((token) => nodeSuite.test(token))) {
          for (const suite of suites) references.add(posix.normalize(posix.join(cwd, suite)));
        }
      } else if (executable === "npm") {
        let directory = cwd;
        const args = [];
        for (let index = 0; index < tokens.length; index += 1) {
          if (tokens[index] === "--prefix") directory = posix.join(cwd, tokens[++index] ?? "");
          else if (tokens[index] !== "--silent") args.push(tokens[index]);
        }
        if (args.length === 1 && args[0] === "test") visitScript(directory, "test");
        else if (args.length === 2 && args[0] === "run") visitScript(directory, args[1]);
      }
    }
  }
  visitScript(".", "verify");
  for (const workflow of workflows) {
    for (const { source, cwd } of countedWorkflowCommands(workflow)) visitCommands(source, cwd);
  }
  // Do not infer execution inside preflight's shell control flow. Its current
  // lint/typecheck/test scripts are already reached through root verify.
  return references;
}

function portableCommand() {
  const command = packageJson.scripts["test:portable-node"];
  const tokens = command.trim().split(/\s+/);
  expect(tokens.slice(0, 2)).toEqual(["node", "--test"]);
  // An explicit allowlist excludes globs, shell operators, and DB/native/provider runners.
  expect(tokens.slice(2).sort()).toEqual([...portableSuites].sort());
  return command;
}

// Listing files does not load test modules or initiate database/provider work.
function listTestFiles(flags = {}) {
  const env = { ...process.env };
  delete env.RUN_QUOTE_INTEGRATION_TESTS;
  delete env.RUN_FICTIV_LIVE_TEST;
  return execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "list", "--filesOnly"], {
    cwd: repoRoot,
    env: { ...env, ...flags },
    encoding: "utf8",
    timeout: 20_000,
  }).trim().split(/\r?\n/);
}

describe("explicit test execution lanes", () => {
  it("references every tracked Node test in a runner or a documented manual lane", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: repoRoot, encoding: "utf8",
    }).split("\0").filter(Boolean);
    const suites = tracked.filter((path) => nodeSuite.test(path));
    const manifests = {};
    const workflows = [];
    for (const path of tracked) {
      if (/(^|\/)package\.json$/.test(path)) manifests[path] = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
      else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) workflows.push(readFileSync(join(repoRoot, path), "utf8"));
    }
    const references = runnerReferences(manifests, workflows);
    for (const [suite, instructions] of Object.entries(manuallyRunNodeSuites)) {
      expect(suites, `stale manual exception: ${suite}`).toContain(suite);
      expect(references.has(suite), `remove the now-wired manual exception: ${suite}`).toBe(false);
      expect(readFileSync(join(repoRoot, instructions), "utf8")).toContain(`node --test ${suite}`);
    }
    expect(suites.filter((suite) => !references.has(suite) && !Object.hasOwn(manuallyRunNodeSuites, suite)),
      "Unwired tracked Node tests: add an explicit runner reference or a reasoned manual-lane exception",
    ).toEqual([]);
  });

  const dummySuite = "scripts/unowned.node-test.cjs";
  const invocation = `node --test ${dummySuite}`;
  const workflowWith = (step, job = {}) => JSON.stringify({ jobs: { test: { "runs-on": "ubuntu-latest", ...job, steps: [step] } } });

  it.each(["scripts/new suite.node-test.mjs", "scripts/new+suite.node-test.cjs", "scripts/測試.node-test.js"])(
    "discovers %s even when no supported invocation owns it", (suite) => {
      const tracked = [suite, "scripts/not-a-suite.mjs"];
      expect(tracked.filter((path) => nodeSuite.test(path)))
        .toEqual([suite]);
      expect(runnerReferences({}, []).has(suite)).toBe(false);
    },
  );

  it.each([
    ["single command", invocation],
    ["final AND-list", `${invocation} && echo passed`],
    ["standalone lines", `${invocation}\necho final-success`],
  ])("requires failure propagation for a supported bash %s", (_label, source) => {
    expect([...runnerReferences({}, [workflowWith({ run: source, shell: "bash" })])]).toEqual([dummySuite]);
    const result = spawnSync("bash", ["-e", "-c", `node() { return 23; }\n${source}`], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(23);
  });

  it("rejects the AND-list counterexample that actually exits successfully under bash -e", () => {
    const source = `${invocation} && echo passed\necho final-success`;
    const result = spawnSync("bash", ["-e", "-c", `node() { return 23; }\n${source}`], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect([...runnerReferences({}, [workflowWith({ run: source })])]).toEqual([]);
  });

  it("supports literal true conditions, inherited bash and the exact Windows exit handoff", () => {
    const workflow = workflowWith({ run: invocation, if: "${{ true }}" },
      { if: true, defaults: { run: { shell: "bash" } } });
    expect([...runnerReferences({}, [workflow])]).toEqual([dummySuite]);
    expect([...runnerReferences({}, [workflowWith({ shell: "powershell", run: `${invocation}\nexit $LASTEXITCODE` })])])
      .toEqual([dummySuite]);
  });

  it("owns quoted paths with spaces or plus signs without narrowing discovery", () => {
    const suites = ["scripts/new suite.node-test.mjs", "scripts/new+suite.node-test.cjs"];
    expect([...runnerReferences({}, [workflowWith({ run: `node --test '${suites[0]}' "${suites[1]}"` })])])
      .toEqual(suites);
  });

  it.each([
    ["paths filter", JSON.stringify({ on: { pull_request: { paths: [dummySuite] } } })],
    ["step name", workflowWith({ name: invocation, run: "echo checking" })],
    ["echo", workflowWith({ run: `echo ${invocation}` })],
    ["quoted echo", workflowWith({ run: `echo "example && ${invocation}"` })],
    ["multiline echo", workflowWith({ run: `echo "example\n${invocation}\n"` })],
    ["heredoc data", workflowWith({ run: `cat <<EOF\n${invocation}\nEOF` })],
    ["comment", workflowWith({ run: `# ${invocation}` })],
    ["disabled job", workflowWith({ run: invocation }, { if: false })],
    ["disabled step", workflowWith({ run: invocation, if: false })],
    ["false expression", workflowWith({ run: invocation, if: "${{ false }}" })],
    ["false comparison", workflowWith({ run: invocation, if: "${{ 1 == 0 }}" })],
    ["conditional job", workflowWith({ run: invocation }, { if: "${{ 1 == 0 }}" })],
    ["unknown condition", workflowWith({ run: invocation, if: "${{ inputs.run_tests }}" })],
    ["disabled shell branch", workflowWith({ run: `if false; then\n${invocation}\nfi` })],
    ["AND-list followed by success", workflowWith({ run: `${invocation} && echo passed\necho final-success` })],
    ["custom bash shell", workflowWith({ run: invocation, shell: "bash {0}" })],
    ["custom job shell", workflowWith({ run: invocation }, { defaults: { run: { shell: "bash {0}" } } })],
    ["custom workflow shell", JSON.stringify({ defaults: { run: { shell: "bash {0}" } }, jobs: { test: { steps: [{ run: invocation }] } } })],
    ["PowerShell without exit handoff", workflowWith({ run: invocation, shell: "powershell" })],
    ["PowerShell resets exit status", workflowWith({ run: `${invocation}\nnode other.mjs\nexit $LASTEXITCODE`, shell: "powershell" })],
    ["unknown implicit shell", workflowWith({ run: invocation }, { "runs-on": "self-hosted" })],
    ["allowed job failure", workflowWith({ run: invocation }, { "continue-on-error": true })],
    ["allowed step failure", workflowWith({ run: invocation, "continue-on-error": true })],
    ["or true", workflowWith({ run: `${invocation} || true` })],
    ["semicolon true", workflowWith({ run: `${invocation}; true` })],
    ["or colon", workflowWith({ run: `${invocation} || :` })],
    ["pipe", workflowWith({ run: `${invocation} | cat` })],
    ["disabled errexit", workflowWith({ run: `set +e\n${invocation}` })],
    ["shell function", workflowWith({ run: `never_run() {\n${invocation}\n}` })],
    ["early exit", workflowWith({ run: `exit 0\n${invocation}` })],
    ["substitution", workflowWith({ run: `echo $(${invocation})` })],
    ["subshell", workflowWith({ run: `( ${invocation} )` })],
    ["argument to another Node entrypoint", workflowWith({ run: `node helper.mjs ${dummySuite}` })],
  ])("does not count a workflow %s as suite execution", (_label, workflow) => {
    expect([...runnerReferences({}, [workflow], "")]).toEqual([]);
  });

  it.each(["", "echo npm run test:orphan", "npm run test:orphan || true", "npm run test:orphan; true", "npm run test:orphan || :"])(
    "does not reach an orphan npm script from %j", (run) => {
      expect([...runnerReferences({ "package.json": { scripts: { "test:orphan": invocation } } }, [workflowWith({ run })], "")]).toEqual([]);
    },
  );

  it.each(["|| true", "; true", "|| :"])("does not count swallowed npm script failure (%s)", (suffix) => {
    expect([...runnerReferences({ "package.json": { scripts: { verify: "npm run suite", suite: `${invocation} ${suffix}` } } }, [], "")]).toEqual([]);
  });

  it("rejects multiline npm bodies and shell wrappers instead of inferring preflight control flow", () => {
    for (const source of [`${invocation}\necho final-success`, `if false; then\n${invocation}\nfi`, "bash scripts/preflight.sh"]) {
      expect([...runnerReferences({ "package.json": { scripts: { verify: source } } }, [])]).toEqual([]);
    }
  });

  it("follows required npm chains, npm test and package-relative paths", () => {
    const manifests = {
      "package.json": { scripts: {
        verify: "npm run chain && npm --prefix worker run checks",
        chain: "npm run lint && npm run sensitive-paths:report",
        "sensitive-paths:report": `node ${dummySuite}`,
        test: "node --test scripts/default.node-test.js",
        lint: "node --test scripts/preflight.node-test.mjs",
      } },
      "worker/package.json": { scripts: { checks: "node --test scripts/worker.node-test.mjs" } },
    };
    expect([...runnerReferences(manifests, [workflowWith({ run: "npm test" })])].sort())
      .toEqual([dummySuite, "scripts/default.node-test.js", "scripts/preflight.node-test.mjs", "worker/scripts/worker.node-test.mjs"].sort());
  });

  it("reads YAML run bodies, continuations, quotes and workflow working directories", () => {
    const workflow = `jobs:\n  test:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: worker\n    steps:\n      - run: |\n          node --test \\\n            './a.node-test.cjs' b.node-test.js\n`;
    expect([...runnerReferences({}, [workflow], "")]).toEqual(["worker/a.node-test.cjs", "worker/b.node-test.js"]);
  });

  it("requires the portable Node allowlist in root verification and the CI test job", () => {
    portableCommand();
    expect(packageJson.scripts.verify.split("&&").map((step) => step.trim()))
      .toEqual(expect.arrayContaining(["npm run test:portable-node", "npm run test:agent-control-plane"]));
    const lines = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").split("\n");
    const start = lines.indexOf("  test:");
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && /^  [\w-]+:/.test(line));
    const testJob = lines.slice(start, end < 0 ? undefined : end).join("\n");
    expect(testJob).toMatch(/^        run: npm run test:portable-node\s*$/m);
    expect(testJob).toMatch(/^        run: npm run test:agent-control-plane\s*$/m);
    const portableStep = testJob.split(/^      - /m)
      .find((step) => /^        run: npm run test:portable-node\s*$/m.test(step));
    expect(portableStep).not.toMatch(/^        (?:continue-on-error|if):/m);
    expect(testJob).not.toMatch(/^    continue-on-error:/m);
  });

  it.each([null, ...portableSuites])("runs every portable suite and propagates failure from %s", (failedSuite) => {
    const command = portableCommand();
    const root = mkdtempSync(join(tmpdir(), "portable-node-gate-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({
        private: true, scripts: { "test:portable-node": command },
      }));
      for (const suite of portableSuites) {
        mkdirSync(dirname(join(root, suite)), { recursive: true });
        const imports = suite.endsWith(".cjs")
          ? "const test = require('node:test'); const assert = require('node:assert/strict'); const { writeFileSync } = require('node:fs');"
          : "import test from 'node:test'; import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs';";
        writeFileSync(join(root, suite), `${imports}
test('synthetic portable contract', () => {
  writeFileSync(${JSON.stringify(join(root, `${portableSuites.indexOf(suite)}.ran`))}, 'ran');
  assert.equal(${JSON.stringify(suite === failedSuite)}, false);
});\n`);
      }
      const result = spawnSync("npm", ["run", "test:portable-node"], {
        cwd: root, encoding: "utf8", timeout: 20_000,
        env: { ...process.env, npm_config_offline: "true", npm_config_update_notifier: "false" },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stdout + result.stderr).toBe(failedSuite === null ? 0 : 1);
      for (const [index] of portableSuites.entries()) {
        expect(readFileSync(join(root, `${index}.ran`), "utf8")).toBe("ran");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps database and live-provider suites out of default discovery", () => {
    const files = listTestFiles();
    expect(files).toContain("scripts/ovd420-recovery-egress-contract.test.mjs");
    expect(files).toContain("scripts/provider-check.test.mjs");
    expect(files).not.toContain(quoteSuite);
    expect(files.some((file) => file.endsWith(".live.test.ts"))).toBe(false);
  }, 30_000);

  it("admits quote integration without admitting live-provider tests", () => {
    const files = listTestFiles({ RUN_QUOTE_INTEGRATION_TESTS: "1" });
    expect(files).toContain(quoteSuite);
    expect(files).not.toContain(liveSuite);
    expect(packageJson.scripts["test:integration:quote"]).toBe(
      "RUN_QUOTE_INTEGRATION_TESTS=1 vitest run " + quoteSuite,
    );
  }, 30_000);

  it("requires the live flag independently of quote integration", () => {
    const files = listTestFiles({ RUN_FICTIV_LIVE_TEST: "1" });
    expect(files).toContain(liveSuite);
    expect(files).not.toContain(quoteSuite);
    expect(packageJson.scripts["test:live:fictiv"]).toBe(
      "RUN_FICTIV_LIVE_TEST=1 vitest run " + liveSuite,
    );
  }, 30_000);

  it("retains the provider gate and includes the omitted payment safety suite", () => {
    expect(packageJson.scripts.verify).toContain("npm run provider:check");
    expect(packageJson.scripts.verify).toContain("npm run provider:permissions");
    expect(packageJson.scripts["test:functions"]).toContain(
      "supabase/functions/create-payment-intent/index.test.ts",
    );
    const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).toContain("run: npm run test:integration:quote");
    expect(ci).toContain("ovd420-recovery-egress-network:");
    expect(ci).toContain('needs.ovd420-recovery-egress-network.result');
  });
});
