// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// js-yaml ships with eslint (a dev dependency); no direct dependency added.
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_REQUIRED_CHECKS } from "./gate.mjs";

const loadWorkflow = (name) => yaml.load(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const workflow = loadWorkflow("qa-handoff.yml");
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

describe("qa-handoff.yml", () => {
  it("has exactly pull-requests: write and contents: read, with no job-level overrides", () => {
    expect(workflow.permissions).toEqual({ "pull-requests": "write", contents: "read" });
    for (const job of Object.values(workflow.jobs)) expect(job.permissions).toBeUndefined();
  });

  it("triggers only on workflow_run completed for the required-check workflows", () => {
    // js-yaml reads the bare `on` key as the string "on".
    expect(Object.keys(workflow.on)).toEqual(["workflow_run"]);
    expect(workflow.on.workflow_run.types).toEqual(["completed"]);
    expect(workflow.on.workflow_run.workflows).toEqual(["CI", "PR body gate"]);
  });

  it("serializes per PR without cancelling in-flight runs", () => {
    expect(workflow.concurrency.group).toBe(
      "qa-handoff-${{ github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.head_branch }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("never checks out PR code", () => {
    const checkouts = steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.with?.ref).toBe("${{ github.event.repository.default_branch }}");
      const serialized = JSON.stringify(step);
      expect(serialized).not.toMatch(/workflow_run\.head_sha|workflow_run\.head_branch|workflow_run\.head_repository|pull_request|refs\/pull/);
      expect(step.with?.repository).toBeUndefined();
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("runs only for workflow_run events triggered by pull_request", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("github.event.workflow_run.event == 'pull_request'");
    }
  });

  it("never fetches or checks out PR refs in a run step", () => {
    for (const step of steps.filter((item) => item.run)) {
      expect(step.run).not.toContain("gh pr checkout");
      expect(step.run).not.toContain("refs/pull");
      expect(step.run).not.toContain("git fetch");
    }
  });

  it("passes event values through env, not inline into run scripts", () => {
    for (const step of steps.filter((item) => item.run)) {
      expect(step.run).not.toContain("${{");
    }
  });

  it("reads trusted marker authors from the repo variable, through step env only", () => {
    const step = steps.find((item) => item.run?.includes("run.mjs"));
    expect(step.env.QA_HANDOFF_TRUSTED_MARKER_AUTHORS).toBe("${{ vars.QA_HANDOFF_TRUSTED_MARKER_AUTHORS }}");
    expect(step.run).not.toContain("QA_HANDOFF_TRUSTED_MARKER_AUTHORS");
  });

  it("defaults to report mode and documents the required-check fallback", () => {
    const job = workflow.jobs["qa-handoff"];
    expect(job.env.QA_HANDOFF_MODE).toBe("report");
    expect(job.env.REQUIRED_CHECKS.split(",")).toEqual([...DEFAULT_REQUIRED_CHECKS]);
  });
});

// qa-handoff.yml checks out the default branch with
// `sparse-checkout: scripts/qa-handoff` (cone mode) and then runs
// `node scripts/qa-handoff/run.mjs`. Anything outside that directory is not on
// disk in the workflow, so a relative import that leaves it fails with
// ERR_MODULE_NOT_FOUND on the default branch, where this PR's own CI cannot see
// it. That is why run.mjs keeps its own isInvokedDirectly instead of importing
// scripts/lib/entry-point.mjs. Moving it onto the shared helper is a follow-up
// that must widen the workflow's sparse checkout (an infra_ci change) first.
const qaHandoffDir = fileURLToPath(new URL(".", import.meta.url));
const runPath = path.join(qaHandoffDir, "run.mjs");

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Every module specifier written in a module: `from "x"`, `import "x"` and
// `import("x")`. A dynamic import whose specifier is not a string literal
// cannot be checked here, so it is reported rather than skipped.
function moduleSpecifiers(source) {
  const code = stripComments(source);
  const literals = [...code.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g)].map(
    (match) => match[1] ?? match[2],
  );
  const dynamicCalls = [...code.matchAll(/\bimport\s*\(/g)].length;
  const dynamicLiterals = [...code.matchAll(/\bimport\s*\(\s*["'][^"']+["']/g)].length;
  return { literals, unanalyzable: dynamicCalls - dynamicLiterals };
}

// Walk the relative imports reachable from `entry`. Returns the files visited
// and the problems found: a specifier that resolves outside `root`, a target
// that does not exist, or a dynamic import that cannot be read statically.
function walkRelativeImports(entry, root) {
  const visited = new Set();
  const problems = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const { literals, unanalyzable } = moduleSpecifiers(readFileSync(file, "utf8"));
    const rel = (target) => path.relative(root, target);
    if (unanalyzable > 0) problems.push(`${rel(file)}: ${unanalyzable} dynamic import(s) with a non-literal specifier`);
    for (const specifier of literals) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      const inside = path.relative(root, target);
      if (inside.startsWith("..") || path.isAbsolute(inside)) {
        problems.push(`${rel(file)} imports "${specifier}", which is outside ${path.basename(root)}/`);
      } else if (!existsSync(target)) {
        problems.push(`${rel(file)} imports "${specifier}", which does not exist`);
      } else {
        queue.push(target);
      }
    }
  }
  return { visited, problems };
}

describe("qa-handoff sparse checkout", () => {
  it("is still scoped to scripts/qa-handoff, which is what the import check below assumes", () => {
    const checkouts = steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(step.with?.["sparse-checkout"]).toBe("scripts/qa-handoff");
  });

  it("keeps every relative import reachable from run.mjs inside scripts/qa-handoff", () => {
    const { visited, problems } = walkRelativeImports(runPath, qaHandoffDir);
    expect(problems).toEqual([]);
    // The walk really followed run.mjs into its siblings.
    expect([...visited].map((file) => path.basename(file)).sort()).toEqual(["gate.mjs", "run.mjs", "sanitize-log.mjs"]);
  });

  it("flags an import that leaves the directory, a missing target and a non-literal dynamic import", () => {
    // Guards the checker itself: a walker that never reports would pass the
    // test above no matter what run.mjs imports.
    const fixture = mkdtempSync(path.join(tmpdir(), "qa-handoff-imports-"));
    try {
      mkdirSync(path.join(fixture, "qa-handoff"));
      mkdirSync(path.join(fixture, "lib"));
      writeFileSync(path.join(fixture, "lib", "shared.mjs"), "export const x = 1;\n");
      writeFileSync(path.join(fixture, "qa-handoff", "helper.mjs"), 'import { x } from "../lib/shared.mjs";\nexport { x };\n');
      writeFileSync(
        path.join(fixture, "qa-handoff", "entry.mjs"),
        [
          '// import { y } from "../lib/commented.mjs";',
          'import { a } from "node:fs";',
          'import { b } from "./helper.mjs";',
          'import "./missing.mjs";',
          "const later = await import(`./${name}.mjs`);",
          "",
        ].join("\n"),
      );
      const { problems } = walkRelativeImports(path.join(fixture, "qa-handoff", "entry.mjs"), path.join(fixture, "qa-handoff"));
      expect(problems).toEqual([
        "entry.mjs: 1 dynamic import(s) with a non-literal specifier",
        'entry.mjs imports "./missing.mjs", which does not exist',
        'helper.mjs imports "../lib/shared.mjs", which is outside qa-handoff/',
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("pr-body-gate.yml", () => {
  it("re-runs on draft to ready so a workflow_run reaches qa-handoff", () => {
    expect(loadWorkflow("pr-body-gate.yml").on.pull_request.types).toContain("ready_for_review");
  });
});
