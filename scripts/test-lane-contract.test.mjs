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

const isMapping = (value) => value !== null && typeof value === "object"
  && Object.getPrototypeOf(value) === Object.prototype;

// YAML merge keys are not interpreted. Reject them anywhere, including aliases.
function hasMergeKey(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.hasOwn(value, "<<") || Object.values(value).some((child) => hasMergeKey(child, seen));
}

function workflowEvents(workflow) {
  const on = workflow?.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return on && typeof on === "object" ? Object.keys(on) : [];
}

function automaticallyTriggered(workflow) {
  const events = workflowEvents(workflow);
  // No merge queue is configured here: revisit merge_group if one is enabled.
  // A push trigger must not hide a declared but ineffective PR trigger.
  const event = events.includes("pull_request") ? "pull_request" : "push";
  if (!events.includes(event)) return false;
  const filters = isMapping(workflow.on) ? workflow.on[event] : null;
  if (filters === null) return true;
  if (!isMapping(filters)) return false;
  if (event === "pull_request" && Object.hasOwn(filters, "types")
    && (!Array.isArray(filters.types) || !filters.types.includes("synchronize"))) return false;
  // Conservatively reject all ignore filters, not just the all-matching glob.
  if (["branches-ignore", "paths-ignore"].some((key) => Object.hasOwn(filters, key))) return false;
  if (event === "push" && (Object.hasOwn(filters, "tags") || Object.hasOwn(filters, "tags-ignore"))
    && !Object.hasOwn(filters, "branches")) return false;
  return ["branches", "paths"].every((key) => !Object.hasOwn(filters, key)
    || (Array.isArray(filters[key]) && filters[key].length > 0
      && filters[key].every((pattern) => typeof pattern === "string" && !pattern.includes("${{"))
      && filters[key].some((pattern) => pattern.length > 0 && !pattern.startsWith("!"))));
}

const enabled = (entry) => (entry.if === undefined || entry.if === true
  || /^\$\{\{\s*true\s*\}\}$/.test(entry.if))
  && (entry["continue-on-error"] === undefined || entry["continue-on-error"] === false);

// Environment that lets a failing Node test or npm script exit 0 without
// running it (for example NODE_TEST_CONTEXT=child, NODE_OPTIONS=--test-only,
// npm_config_script_shell=true). Unknown env maps and these keys are rejected;
// expressions in values under other literal keys do not mask execution.
// SHELLOPTS=noexec skips the suite. BASHOPTS is rejected conservatively as
// another startup option channel; BASHOPTS=noexec alone does not enable noexec.
const masksExecution = (env) => env !== undefined && (!isMapping(env) || Object.keys(env)
  .some((key) => /^(?:NODE_OPTIONS|NODE_TEST_CONTEXT|BASH_ENV|ENV|PATH|SHELLOPTS|BASHOPTS)$|^npm_config_/i.test(key.replaceAll("-", "_"))));

// Deliberately avoid matrix expansion: include/exclude, empty dimensions and
// expressions need a separately proven lane, even if some combinations survive.
const runnableMatrix = (job) => job.strategy === undefined || (isMapping(job.strategy)
  && (!Object.hasOwn(job.strategy, "matrix") || (isMapping(job.strategy.matrix)
    && Object.keys(job.strategy.matrix).length > 0
    && !JSON.stringify(job.strategy.matrix).includes("${{")
    && Object.entries(job.strategy.matrix).every(([key, values]) => !["include", "exclude"].includes(key)
      && Array.isArray(values) && values.length > 0))));

// No repository workflow needs Docker options. Reject the key outright rather
// than partially interpreting Docker's bundled short flags or expression values.
const masksContainer = (container) => container !== undefined && (typeof container === "string"
  ? container.includes("${{")
  : !isMapping(container) || Object.hasOwn(container, "options") || masksExecution(container.env));

// workflows: [{ path, source }] or bare sources. Credit starts at workflows with
// an automatic trigger; a workflow_call-only workflow is credited only through
// a credited caller job (`uses: ./.github/workflows/<file>`). A job is credited
// only if it and every job in its `needs` chain are enabled. A reusable caller
// also requires every callee job to be credited recursively (not a runtime proof).
function countedWorkflowCommands(workflows) {
  const parsed = workflows.map((entry) => {
    const { path, source } = typeof entry === "string" ? { source: entry } : entry;
    const workflow = parse(source);
    return { path, workflow: hasMergeKey(workflow) ? null : workflow };
  });
  const byPath = new Map(parsed.filter(({ path }) => path).map((entry) => [entry.path, entry]));
  const reusableTarget = (job) => {
    const callee = typeof job.uses === "string" && /^\.\/(\.github\/workflows\/[\w.-]+\.ya?ml)$/.exec(job.uses);
    const target = callee && byPath.get(callee[1]);
    return target && workflowEvents(target.workflow).includes("workflow_call") ? target : null;
  };
  const memo = new Map();
  const jobCredited = (entry, id, path = new Set()) => {
    const { workflow } = entry;
    const jobs = workflow?.jobs ?? {};
    const job = Object.hasOwn(jobs, id) ? jobs[id] : undefined;
    if (!job || path.has(job) || !enabled(job) || masksExecution(workflow?.env)
      || masksExecution(job.env) || masksContainer(job.container) || !runnableMatrix(job)) return false;
    if (memo.has(job)) return memo.get(job);
    const next = new Set(path).add(job);
    const needs = job.needs === undefined ? [] : [job.needs].flat();
    let result = needs.every((need) => typeof need === "string" && jobCredited(entry, need, next));
    if (job.uses !== undefined) {
      const target = reusableTarget(job);
      const ids = Object.keys(target?.workflow?.jobs ?? {});
      result = result && Boolean(target) && ids.length > 0 && ids.every((key) => jobCredited(target, key, next));
    }
    memo.set(job, result);
    return result;
  };
  const credited = new Set(parsed.filter(({ workflow }) => automaticallyTriggered(workflow)));
  const queue = [...credited];
  const commands = [];
  while (queue.length) {
    const entry = queue.shift();
    const { workflow } = entry;
    if (masksExecution(workflow?.env)) continue;
    const jobs = workflow?.jobs ?? {};
    for (const [id, job] of Object.entries(jobs)) {
      if (!jobCredited(entry, id)) continue;
      const target = reusableTarget(job);
      if (target && !credited.has(target)) {
        credited.add(target);
        queue.push(target);
      }
      commands.push(...jobCommands(workflow, job));
    }
  }
  return commands;
}

function jobCommands(workflow, job) {
  return (job.steps ?? []).filter((step) => enabled(step) && typeof step.run === "string" && !masksExecution(step.env))
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
      });
}

// Only portable, repository-relative literal paths establish ownership. Reject
// traversal even if normalization would stay inside: symlink/.. can resolve to
// a different file. Colons/backslashes exclude drive, UNC and platform aliases.
function repositoryPath(cwd, path) {
  if (typeof path !== "string" || !/^[\w ./+-]+$/.test(path)
    || /^[/-]/.test(path) || path.split("/").some((part) => part !== "." && /[. ]$/.test(part))) return null;
  return posix.join(cwd, path);
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
    cwd = repositoryPath(".", cwd);
    if (cwd === null) return;
    for (const raw of requiredCommands(source, npmScript)) {
      const tokens = [...raw];
      const executable = tokens.shift();
      if (executable === "node") {
        let testRunner = false;
        while (["--test", "--experimental-strip-types"].includes(tokens[0])) {
          if (tokens.shift() === "--test") testRunner = true;
        }
        if (tokens[0] === "--") tokens.shift();
        // With plain node only the entrypoint runs; later arguments are data.
        const suites = testRunner ? tokens : tokens.slice(0, 1);
        const paths = suites.map((suite) => nodeSuite.test(suite) ? repositoryPath(cwd, suite) : null);
        if (paths.length && paths.every((path) => path !== null)) paths.forEach((path) => references.add(path));
      } else if (executable === "npm") {
        let directory = cwd;
        let prefixed = false;
        const args = [];
        for (let index = 0; index < tokens.length; index += 1) {
          if (tokens[index] === "--prefix") {
            if (prefixed) { directory = null; break; }
            prefixed = true;
            directory = repositoryPath(cwd, tokens[++index]);
          }
          else if (tokens[index] !== "--silent") args.push(tokens[index]);
        }
        if (directory === null) continue;
        if (args.length === 1 && args[0] === "test") visitScript(directory, "test");
        else if (args.length === 2 && args[0] === "run" && !args[1].startsWith("-")) visitScript(directory, args[1]);
      }
    }
  }
  // Package scripts count only when a credited workflow step reaches them; no
  // workflow runs root `verify`, so it is not an ownership root by itself.
  for (const { source, cwd } of countedWorkflowCommands(workflows)) visitCommands(source, cwd);
  // Do not infer execution inside preflight's shell control flow.
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
      else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) workflows.push({ path, source: readFileSync(join(repoRoot, path), "utf8") });
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
  const workflowWith = (step, job = {}) => JSON.stringify({
    on: { pull_request: {} }, jobs: { test: { "runs-on": "ubuntu-latest", ...job, steps: [step] } },
  });
  const verifyStep = workflowWith({ run: "npm run verify" });

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

  it("does not infer event expressions", () => {
    const workflow = JSON.parse(workflowWith({ run: invocation }));
    workflow.jobs.test.if = "github.event_name == 'workflow_dispatch'";
    expect([...runnerReferences({}, [JSON.stringify(workflow)])]).toEqual([]);
  });

  it.each([
    ["pull_request map", { pull_request: {} }], ["push map", { push: { branches: ["main"] } }],
    ["string form", "pull_request"], ["list form", ["workflow_dispatch", "push"]],
  ])("credits a workflow with an automatic %s trigger", (_label, on) => {
    const workflow = { ...JSON.parse(workflowWith({ run: invocation })), on };
    expect([...runnerReferences({}, [JSON.stringify(workflow)])]).toEqual([dummySuite]);
  });

  it.each([
    ["dispatch-only", { workflow_dispatch: {} }], ["schedule-only", { schedule: [{ cron: "0 0 * * *" }] }],
    ["pull_request_target", { pull_request_target: {} }], ["uncalled workflow_call", { workflow_call: {} }],
    ["missing on", undefined], ["empty list", []],
  ])("does not count a %s workflow as CI execution", (_label, on) => {
    const workflow = { ...JSON.parse(workflowWith({ run: invocation })), on };
    if (on === undefined) delete workflow.on;
    expect([...runnerReferences({}, [JSON.stringify(workflow)])]).toEqual([]);
  });

  const graph = (jobs, on = { pull_request: {} }) => JSON.stringify({ on, jobs });
  const owner = (extra = {}) => ({ "runs-on": "ubuntu-latest", steps: [{ run: invocation }], ...extra });
  const plain = (extra = {}) => ({ "runs-on": "ubuntu-latest", steps: [{ run: "echo ok" }], ...extra });

  it.each([
    ["an if:false job", { never: plain({ if: false }), test: owner({ needs: "never" }) }],
    ["an unknown-condition job", { maybe: plain({ if: "${{ inputs.go }}" }), test: owner({ needs: ["maybe"] }) }],
    ["a missing job", { test: owner({ needs: ["absent"] }) }],
    ["a transitively disabled job", { never: plain({ if: false }), mid: plain({ needs: "never" }), test: owner({ needs: "mid" }) }],
    ["an allowed-failure job", { soft: plain({ "continue-on-error": true }), test: owner({ needs: "soft" }) }],
    ["a dependency cycle", { a: plain({ needs: "test" }), test: owner({ needs: "a" }) }],
  ])("does not credit a job whose needs chain reaches %s", (_label, jobs) => {
    expect([...runnerReferences({}, [graph(jobs)])]).toEqual([]);
  });

  it("credits a job whose whole needs chain is enabled", () => {
    const jobs = { a: plain(), b: plain({ needs: "a" }), test: owner({ needs: ["a", "b"] }) };
    expect([...runnerReferences({}, [graph(jobs)])]).toEqual([dummySuite]);
  });

  const reusable = { path: ".github/workflows/reusable.yml", source: graph({ test: owner() }, { workflow_call: {} }) };
  const caller = (job = {}, on = { pull_request: {} }) => ({
    path: ".github/workflows/caller.yml",
    source: graph({ setup: plain(), call: { uses: "./.github/workflows/reusable.yml", ...job } }, on),
  });

  it("credits a workflow_call workflow only through a credited caller job", () => {
    expect([...runnerReferences({}, [reusable])]).toEqual([]);
    expect([...runnerReferences({}, [reusable, caller()])]).toEqual([dummySuite]);
    expect([...runnerReferences({}, [reusable, caller({ needs: "setup" })])]).toEqual([dummySuite]);
  });

  it.each([
    ["a disabled caller job", caller({ if: false })],
    ["a caller job needing a disabled job", { path: ".github/workflows/caller.yml",
      source: graph({ never: plain({ if: false }), call: { uses: "./.github/workflows/reusable.yml", needs: "never" } }) }],
    ["a dispatch-only caller workflow", caller({}, { workflow_dispatch: {} })],
    ["a caller of another file", { path: ".github/workflows/caller.yml",
      source: graph({ call: { uses: "./.github/workflows/other.yml" } }) }],
    ["a remote ref", { path: ".github/workflows/caller.yml",
      source: graph({ call: { uses: "optomachina/Overdrafter/.github/workflows/reusable.yml@main" } }) }],
  ])("does not credit a workflow_call workflow through %s", (_label, callerWorkflow) => {
    expect([...runnerReferences({}, [reusable, callerWorkflow])]).toEqual([]);
  });

  it.each([
    ["workflow", (w) => { w.env = { NODE_TEST_CONTEXT: "child" }; }],
    ["job", (w) => { w.jobs.test.env = { NODE_OPTIONS: "--test-only" }; }],
    ["step", (w) => { w.jobs.test.steps[0].env = { npm_config_script_shell: "true" }; }],
    ["step (upper case npm config)", (w) => { w.jobs.test.steps[0].env = { NPM_CONFIG_IGNORE_SCRIPTS: "true" }; }],
  ])("does not count execution under %s env that can mask a failing suite", (_label, mutate) => {
    const workflow = JSON.parse(workflowWith({ run: invocation }));
    mutate(workflow);
    expect([...runnerReferences({}, [JSON.stringify(workflow)])]).toEqual([]);
  });

  it("proves NODE_TEST_CONTEXT=child makes a failing Node suite exit 0", () => {
    const root = mkdtempSync(join(tmpdir(), "lane-env-mask-"));
    try {
      writeFileSync(join(root, "fail.node-test.cjs"), "require('node:test')('fails', () => { throw new Error('masked'); });\n");
      const run = (env) => spawnSync(process.execPath, ["--test", "fail.node-test.cjs"], {
        cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, ...env },
      }).status;
      expect(run({})).toBe(1);
      expect(run({ NODE_TEST_CONTEXT: "child" })).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  describe("round 5 shell options and filter elements", () => {
    const scopes = [
      ["workflow", (w) => w], ["job", (w) => w.jobs.test],
      ["step", (w) => w.jobs.test.steps[0]],
      ["container", (w) => (w.jobs.test.container = { image: "node:20" })],
    ];
    describe.each(["SHELLOPTS", "shellopts", "BASHOPTS", "bashopts"])("%s", (key) => {
      it.each(scopes)("rejects shell-option env at %s scope, directly and in a reusable callee", (_label, scope) => {
        const workflow = JSON.parse(workflowWith({ run: invocation }));
        scope(workflow).env = { [key]: "noexec" };
        expect([...runnerReferences({}, [JSON.stringify(workflow)])]).toEqual([]);
        workflow.on = "workflow_call";
        expect([...runnerReferences({}, [caller(), { ...reusable, source: JSON.stringify(workflow) }])]).toEqual([]);
      });
    });
    it.each(["SHELLOPTS", "BASHOPTS"])("rejects %s in a matrix-sourced container", (key) => {
      const strategy = { matrix: { c: [{ image: "node:20", env: { [key]: "noexec" } }] } };
      expect([...runnerReferences({}, [workflowWith({ run: invocation }, {
        container: "${{ matrix.c }}", strategy,
      })])]).toEqual([]);
    });
    it("rejects the reviewer's SHELLOPTS container with a Bash default", () => {
      expect([...runnerReferences({}, [workflowWith({ run: invocation }, {
        container: { image: "node:20", env: { SHELLOPTS: "noexec" } }, defaults: { run: { shell: "bash" } },
      })])]).toEqual([]);
    });
    it.each([["SHELLOPTS", 0], ["BASHOPTS", 1]])(
      "hermetically checks %s=noexec against a failing suite and rejects that owner", (key, status) => {
        const root = mkdtempSync(join(tmpdir(), "lane-shellopts-"));
        try {
          writeFileSync(join(root, "fail.node-test.cjs"), "require('node:test')('fails', () => { throw new Error('masked'); });\n");
          const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root };
          const run = (extra) => spawnSync("bash", ["--norc", "--noprofile", "-e", "-o", "pipefail", "-c", "node --test fail.node-test.cjs"], {
            cwd: root, encoding: "utf8", timeout: 15_000, env: { ...env, ...extra },
          });
          const control = run({});
          expect(control.error).toBeUndefined();
          expect(control.status, control.stderr).toBe(1);
          const configured = run({ [key]: "noexec" });
          expect(configured.error).toBeUndefined();
          expect(configured.status, configured.stderr).toBe(status);
          expect([...runnerReferences({}, [workflowWith({ run: invocation, env: { [key]: "noexec" } })])]).toEqual([]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }, 30_000,
    );
    it.each([
      ["branches expression", { push: { branches: ["main", "release/${{ vars.BRANCH }}"] } }],
      ["paths expression", { pull_request: { paths: ["scripts/**", "${{ vars.PATH }}"] } }],
      ["branches non-string", { push: { branches: ["main", 42] } }],
      ["paths non-string", { pull_request: { paths: ["scripts/**", null] } }],
    ])("rejects a filter list containing %s", (_label, on) => {
      expect([...runnerReferences({}, [graph({ test: owner() }, on)])]).toEqual([]);
    });
  });

  describe("round 4 container boundaries", () => {
    it.each(["-ieNODE_TEST_CONTEXT=child", "-te X=1", "-ite X=1", "-teX=1", "--cpus 1", "", null, 1, []])(
      "rejects any container options key: %j", (options) => {
        expect([...runnerReferences({}, [workflowWith({ run: invocation }, { container: { image: "node:20", options } })])])
          .toEqual([]);
      },
    );
    it.each(["${{ fromJSON(vars.C) }}", "${{ matrix.c }}", "node:${{ vars.VERSION }}", [], null, 20])(
      "rejects expression or non-mapping/non-string container: %j", (container) => {
        const strategy = { matrix: { c: [{ image: "node:20", env: { NODE_TEST_CONTEXT: "child" } }] } };
        expect([...runnerReferences({}, [workflowWith({ run: invocation }, { container, strategy })])]).toEqual([]);
      },
    );
    it.each([undefined, "node:20", { image: "node:20" }, { image: "node:20", env: { BUILD_LABEL: "${{ vars.LABEL }}" } }])(
      "credits absent or literal container: %j", (container) => {
        expect([...runnerReferences({}, [workflowWith({ run: invocation }, { container })])]).toEqual([dummySuite]);
      },
    );
    it.each(["!!omap [{BUILD_LABEL: safe}]", "!!set {BUILD_LABEL: null}"])(
      "rejects tagged mappings at container, env and matrix boundaries: %s", (tagged) => {
        const placements = [
          `env: ${tagged}\njobs:\n  test:`,
          `jobs:\n  test:\n    env: ${tagged}`,
          `jobs:\n  test:\n    container: ${tagged}`,
          `jobs:\n  test:\n    container:\n      image: node:20\n      env: ${tagged}`,
          `jobs:\n  test:\n    strategy: ${tagged}`,
          `jobs:\n  test:\n    strategy:\n      matrix: ${tagged}`,
        ];
        for (const placement of placements) {
          const source = `on: pull_request\n${placement}\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${invocation}\n`;
          expect([...runnerReferences({}, [source])], placement).toEqual([]);
        }
        const source = `on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${invocation}\n        env: ${tagged}\n`;
        expect([...runnerReferences({}, [source])]).toEqual([]);
      },
    );
  });

  describe("round 3 ownership gaps", () => {
    const scopes = [
      ["workflow", (w) => w], ["job", (w) => w.jobs.test],
      ["step", (w) => w.jobs.test.steps[0]],
      ["container", (w) => (w.jobs.test.container = { image: "node:20" })],
    ];
    it.each(scopes)("rejects masking keys and non-mapping env at %s scope", (_label, scope) => {
      for (const env of [
        ...["npm_config_script-shell", "NPM_CONFIG_SCRIPT-SHELL", "npm-config-script_shell",
          "npm_config_", "BASH_ENV", "ENV", "PATH", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]
          .map((key) => ({ [key]: "masked" })),
        "${{ fromJSON(vars.X) }}", [], null,
      ]) {
        const workflow = JSON.parse(workflowWith({ run: invocation }));
        scope(workflow).env = env;
        expect([...runnerReferences({}, [JSON.stringify(workflow)])], JSON.stringify(env)).toEqual([]);
      }
    });
    it.each(scopes)("allows expression values under harmless literal env keys at %s scope", (_label, scope) => {
      const workflow = JSON.parse(workflowWith({ run: invocation }));
      scope(workflow).env = { BUILD_LABEL: "${{ vars.LABEL }}" };
      expect([...runnerReferences({}, [JSON.stringify(workflow)])]).toEqual([dummySuite]);
    });
    it.each(["--env NODE_TEST_CONTEXT=child", "--env=PATH=/tmp", "-e PATH=/tmp", "-ePATH=/tmp",
      "--env-file=/tmp/env", "${{ vars.OPTIONS }}"])("rejects container options %s", (options) => {
      expect([...runnerReferences({}, [workflowWith({ run: invocation }, { container: { image: "node:20", options } })])])
        .toEqual([]);
    });
    it("does not treat service-container env as run-step env", () => {
      expect([...runnerReferences({}, [workflowWith({ run: invocation }, {
        container: { image: "node:20" },
        services: { db: { image: "postgres", env: { PATH: "/service-only", NODE_TEST_CONTEXT: "child" } } },
      })])]).toEqual([dummySuite]);
    });
    it("round 4: hermetically proves BASH_ENV can hide a failing suite and rejects that owner", () => {
      const root = mkdtempSync(join(tmpdir(), "lane-bash-env-"));
      try {
        writeFileSync(join(root, "fail.node-test.cjs"), "require('node:test')('fails', () => { throw new Error('masked'); });\n");
        const startup = join(root, "startup.sh");
        writeFileSync(startup, "node() { return 0; }\n");
        const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root };
        const run = (extra) => spawnSync("bash", ["--norc", "--noprofile", "-e", "-c", "node --test fail.node-test.cjs"], {
          cwd: root, encoding: "utf8", timeout: 15_000, env: { ...env, ...extra },
        });
        const control = run({});
        const masked = run({ BASH_ENV: startup });
        expect(control.error).toBeUndefined();
        expect(control.status, control.stderr).toBe(1);
        expect(masked.error).toBeUndefined();
        expect(masked.status, masked.stderr).toBe(0);
        expect([...runnerReferences({}, [workflowWith({ run: invocation, env: { BASH_ENV: startup } })])]).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 30_000);
    it.each([
      ["merge_group only", { merge_group: {} }],
      ["closed PR", { pull_request: { types: ["closed"] } }],
      ["labeled PR", { pull_request: { types: ["labeled"] } }],
      ["opened-only PR", { pull_request: { types: ["opened"] } }],
      ["closed PR plus push", { pull_request: { types: ["closed"] }, push: null, merge_group: null }],
      ["tag-only push", { push: { tags: ["v*"] } }],
      ["tag-ignore-only push", { push: { "tags-ignore": ["v*"] } }],
      ["ignored branches", { push: { "branches-ignore": ["**"] } }],
      ["ignored paths", { pull_request: { "paths-ignore": ["**"] } }],
      ["empty branches", { push: { branches: [] } }],
      ["negative-only branches", { push: { branches: ["!**"] } }],
      ["empty paths", { pull_request: { paths: [] } }],
      ["expression filters", { push: "${{ vars.FILTERS }}" }],
    ])("rejects ineffective trigger: %s", (_label, on) => {
      expect([...runnerReferences({}, [graph({ test: owner() }, on)])]).toEqual([]);
    });
    it.each([{ pull_request: { types: ["synchronize"], paths: ["scripts/**"] } },
      { push: { branches: ["main"], tags: ["v*"] } }, { pull_request: null, merge_group: null }])(
      "credits supported trigger filters %j", (on) => {
        expect([...runnerReferences({}, [graph({ test: owner() }, on)])]).toEqual([dummySuite]);
      },
    );
    it.each([
      ["disabled callee", { check: plain({ if: false }) }],
      ["partially disabled callee", { check: plain(), off: plain({ if: false }) }],
      ["empty callee", {}],
      ["masked callee", { check: plain({ env: { PATH: "/tmp" } }) }],
      ["callee cycle", { call: { uses: "./.github/workflows/reusable.yml" } }],
    ])("rejects a dependent owner behind a %s", (_label, jobs) => {
      const root = { path: ".github/workflows/root.yml", source: graph({
        call: { uses: "./.github/workflows/reusable.yml" }, test: owner({ needs: "call" }),
      }) };
      expect([...runnerReferences({}, [root, { ...reusable, source: graph(jobs, "workflow_call") }])]).toEqual([]);
    });
    it("checks nested reusable prerequisites and credits their enabled control", () => {
      const root = { path: ".github/workflows/root.yml", source: graph({
        call: { uses: "./.github/workflows/reusable.yml" }, test: owner({ needs: "call" }),
      }) };
      const middle = { ...reusable, source: graph({ call: { uses: "./.github/workflows/leaf.yaml" } }, "workflow_call") };
      const leaf = (extra) => ({ path: ".github/workflows/leaf.yaml", source: graph({ check: plain(extra) }, "workflow_call") });
      expect([...runnerReferences({}, [root, middle, leaf({ if: false })])]).toEqual([]);
      expect([...runnerReferences({}, [root, middle, leaf({})])]).toEqual([dummySuite]);
    });
    it.each([null, [], "${{ fromJSON(vars.MATRIX) }}", {}, { os: [] }, { os: "${{ vars.OS }}" },
      { os: ["${{ vars.OS }}"] }, { os: ["linux"], exclude: [{ os: "linux" }] },
      { os: ["linux", "macos"], exclude: [{ os: "linux" }] }, { include: [{ os: "linux" }] }])(
      "rejects unsupported or empty matrix %j", (matrix) => {
        expect([...runnerReferences({}, [workflowWith({ run: invocation }, { strategy: { matrix } })])]).toEqual([]);
      },
    );
    it("credits a literal nonempty matrix", () => {
      expect([...runnerReferences({}, [workflowWith({ run: invocation }, { strategy: { matrix: { os: ["linux", "macos"] } } })])])
        .toEqual([dummySuite]);
    });
    it("requires workflow_call on a referenced callee", () => {
      expect([...runnerReferences({}, [caller(), { ...reusable, source: graph({ test: owner() }, "workflow_dispatch") }])])
        .toEqual([]);
    });
    it("credits the .yaml reusable extension", () => {
      expect([...runnerReferences({}, [caller({ uses: "./.github/workflows/reusable.yaml" }),
        { ...reusable, path: ".github/workflows/reusable.yaml" }])]).toEqual([dummySuite]);
    });
    it("does not resolve inherited Object.prototype jobs", () => {
      expect([...runnerReferences({}, [graph({ test: owner({ needs: "constructor" }) })])]).toEqual([]);
    });
    it.each(scopes)("rejects YAML merge keys at %s scope", (_label, scope) => {
      const workflow = JSON.parse(workflowWith({ run: invocation }));
      scope(workflow)["<<"] = { env: { PATH: "/tmp" } };
      expect([...runnerReferences({}, [JSON.stringify(workflow)])]).toEqual([]);
    });
  });

  it("owns quoted paths with spaces or plus signs without narrowing discovery", () => {
    const suites = ["scripts/new suite.node-test.mjs", "scripts/new+suite.node-test.cjs"];
    expect([...runnerReferences({}, [workflowWith({ run: `node --test '${suites[0]}' "${suites[1]}"` })])])
      .toEqual(suites);
  });

  it.each(["/outside", "//server/share", "C:/outside", "C:outside", "\\\\server\\share",
    "../outside", "worker/../../outside", "worker/../scripts", "worker.", "worker ", "-outside", ""])(
    "rejects non-portable or ambiguous paths %j at every ownership boundary", (directory) => {
      const manifests = { [posix.join(directory || ".", "package.json")]: { scripts: { check: invocation } } };
      for (const step of [
        { run: `node --test '${directory}/${dummySuite}'` },
        { run: invocation, "working-directory": directory },
        { run: `npm --prefix '${directory}' run check` },
      ]) expect([...runnerReferences(manifests, [workflowWith(step)])]).toEqual([]);
    },
  );

  it.each([`node --test --require.node-test.cjs`, `node --test --test-name-pattern=${dummySuite}`,
    "npm --prefix run check", "npm --prefix --silent run check", "npm --prefix . --prefix . run check", "npm run --help"])(
    "does not interpret an ambiguous option as a path: %s", (run) => {
      expect([...runnerReferences({ "package.json": { scripts: { check: invocation, "--help": invocation } } }, [workflowWith({ run })])])
        .toEqual([]);
    },
  );

  it.each(["suite", "cwd", "prefix"])("does not own a tracked failing test through an external %s", (boundary) => {
    const fixture = mkdtempSync(join(tmpdir(), "lane-external-"));
    try {
      const repo = join(fixture, "repo");
      mkdirSync(repo);
      const absolute = execFileSync("bash", ["-c", "pwd -P"], { cwd: fixture, encoding: "utf8" }).trim();
      const suite = "outside.node-test.cjs";
      const tracked = posix.join(".", absolute, suite);
      const scripts = { check: `node --test ${suite}` };
      writeFileSync(join(fixture, suite), "require('node:test')('external passes', () => {});\n");
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ private: true, scripts }));
      mkdirSync(dirname(join(repo, tracked)), { recursive: true });
      writeFileSync(join(repo, tracked), "throw new Error('tracked failure sentinel');\n");
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["add", "--", tracked], { cwd: repo });
      expect(execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" })).toBe(`${tracked}\0`);
      const run = boundary === "suite" ? `node --test '${absolute}/${suite}'`
        : boundary === "prefix" ? `npm --prefix '${absolute}' run check` : scripts.check;
      const step = { run, ...(boundary === "cwd" ? { "working-directory": absolute } : {}) };
      const result = spawnSync("bash", ["-e", "-c", run], {
        cwd: boundary === "cwd" ? fixture : repo, encoding: "utf8", timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const failing = spawnSync(process.execPath, ["--test", tracked], { cwd: repo, encoding: "utf8", timeout: 15_000 });
      expect(failing.error).toBeUndefined();
      expect(failing.status).toBe(1);
      expect(failing.stdout).toContain("tracked failure sentinel");
      const manifests = { [posix.join(".", absolute, "package.json")]: { scripts } };
      expect([...runnerReferences(manifests, [workflowWith(step)])]).toEqual([]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);

  it("resolves quoted relative cwd/prefix paths to the same failing repository test", () => {
    const repo = mkdtempSync(join(tmpdir(), "lane-relative-"));
    try {
      const cwd = "worker + space";
      const suite = "tests/a + suite.node-test.cjs";
      const run = `node --test -- './${suite}'`;
      const scripts = { check: run };
      mkdirSync(join(repo, cwd, "tests"), { recursive: true });
      writeFileSync(join(repo, cwd, suite), "throw new Error('relative failure sentinel');\n");
      writeFileSync(join(repo, cwd, "package.json"), JSON.stringify({ private: true, scripts }));
      for (const step of [{ run, "working-directory": `./${cwd}/.` }, { run: `npm --prefix './${cwd}/.' run check` }]) {
        expect([...runnerReferences({ [`${cwd}/package.json`]: { scripts } }, [workflowWith(step)])])
          .toEqual([`${cwd}/${suite}`]);
        const result = spawnSync("bash", ["-e", "-c", step.run], {
          cwd: step["working-directory"] ? join(repo, cwd) : repo, encoding: "utf8", timeout: 15_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("relative failure sentinel");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

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
    ["false AND-list", workflowWith({ run: `false && ${invocation}` })],
    ["AND-list followed by success", workflowWith({ run: `${invocation} && echo passed\necho final-success` })],
    ["custom bash shell", workflowWith({ run: invocation, shell: "bash {0}" })],
    ["custom job shell", workflowWith({ run: invocation }, { defaults: { run: { shell: "bash {0}" } } })],
    ["custom workflow shell", JSON.stringify({ on: "pull_request", defaults: { run: { shell: "bash {0}" } }, jobs: { test: { "runs-on": "ubuntu-latest", steps: [{ run: invocation }] } } })],
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
    ["combined errexit flags", workflowWith({ run: `set +eu\n${invocation}` })],
    ["bare exit", workflowWith({ run: `exit\n${invocation}` })],
    ["shell function", workflowWith({ run: `never_run() {\n${invocation}\n}` })],
    ["early exit", workflowWith({ run: `exit 0\n${invocation}` })],
    ["substitution", workflowWith({ run: `echo $(${invocation})` })],
    ["subshell", workflowWith({ run: `( ${invocation} )` })],
    ["argument to another Node entrypoint", workflowWith({ run: `node helper.mjs ${dummySuite}` })],
  ])("does not count a workflow %s as suite execution", (_label, workflow) => {
    expect([...runnerReferences({}, [workflow])]).toEqual([]);
  });

  it.each(["", "echo npm run test:orphan", "npm run test:orphan || true", "npm run test:orphan; true", "npm run test:orphan || :"])(
    "does not reach an orphan npm script from %j", (run) => {
      expect([...runnerReferences({ "package.json": { scripts: { "test:orphan": invocation } } }, [workflowWith({ run })])]).toEqual([]);
    },
  );

  it.each(["|| true", "; true", "|| :"])("does not count swallowed npm script failure (%s)", (suffix) => {
    expect([...runnerReferences({ "package.json": { scripts: { verify: "npm run suite", suite: `${invocation} ${suffix}` } } }, [verifyStep])]).toEqual([]);
  });

  it("rejects multiline npm bodies and shell wrappers instead of inferring preflight control flow", () => {
    for (const source of [`${invocation}\necho final-success`, `if false; then\n${invocation}\nfi`, "bash scripts/preflight.sh"]) {
      expect([...runnerReferences({ "package.json": { scripts: { verify: source } } }, [verifyStep])]).toEqual([]);
    }
  });

  it("does not treat root verify as an owner unless a credited workflow runs it", () => {
    const manifests = { "package.json": { scripts: { verify: invocation } } };
    expect([...runnerReferences(manifests, [])]).toEqual([]);
    expect([...runnerReferences(manifests, [verifyStep])]).toEqual([dummySuite]);
  });

  it("follows required npm chains, npm test and package-relative paths", () => {
    const manifests = {
      "package.json": { scripts: {
        verify: "npm run chain && npm --prefix worker run checks",
        chain: "npm run lint && npm run sensitive-paths:report && python3 -m unittest checks",
        "sensitive-paths:report": `node ${dummySuite}`,
        test: "node --test scripts/default.node-test.js",
        lint: "node --test scripts/preflight.node-test.mjs",
      } },
      "worker/package.json": { scripts: { checks: "node --test scripts/worker.node-test.mjs" } },
    };
    expect([...runnerReferences(manifests, [workflowWith({ run: "npm test" }), verifyStep])].sort())
      .toEqual([dummySuite, "scripts/default.node-test.js", "scripts/preflight.node-test.mjs", "worker/scripts/worker.node-test.mjs"].sort());
  });

  it("reads YAML run bodies, continuations, quotes and workflow working directories", () => {
    const workflow = `on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: worker\n    steps:\n      - run: |\n          node --test \\\n            './a.node-test.cjs' b.node-test.js\n`;
    expect([...runnerReferences({}, [workflow])]).toEqual(["worker/a.node-test.cjs", "worker/b.node-test.js"]);
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
