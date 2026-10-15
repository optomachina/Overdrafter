import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

/**
 * Execution proof for production-portal default-deny suites. Static checks
 * cannot prove a test ran: `describe(name, { skip: true }, fn)`, an early
 * `return`, `beforeEach((ctx) => ctx.skip())`, a `vi.mock` of the registrar,
 * or a shadowed `describe` all leave the source looking right while the tests
 * never run. This module runs each reviewed provider's default-deny file with
 * vitest's JSON reporter and requires every test the shared registrar
 * registers to be reported for that file with status "passed".
 *
 * Residuals: the expected names come from the shared registrar source, so a
 * change that removes cases from the registrar itself lowers the bar for every
 * provider (that file is shared and reviewed). The run uses the repository
 * vite config with only `include` narrowed, so a config change that alters how
 * every test runs also applies here.
 */

export const DEFAULT_DENY_REGISTRAR_SOURCE = "worker/test-support/productionPortalDefaultDeny.ts";
export const DEFAULT_DENY_REGISTRAR_FUNCTION = "registerProductionPortalAuthorizationRefusals";
export const DEFAULT_DENY_VITEST_CONFIG = "scripts/default-deny-execution.vitest.config.mjs";
export const DEFAULT_DENY_FILES_ENV = "OVD_DEFAULT_DENY_FILES";

export const DEFAULT_DENY_FILE_STATUS_TITLE = "(test file)";

const RUN_TIMEOUT_MS = 180_000;

/**
 * Names of the tests the registrar registers: every `name:` string in its
 * case table plus every literal `it("...")` title in its body.
 */
export function expectedDefaultDenyTestNames(source, fileName = DEFAULT_DENY_REGISTRAR_SOURCE) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const registrar = sourceFile.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === DEFAULT_DENY_REGISTRAR_FUNCTION && statement.body
  ));
  if (!registrar) {
    throw new Error(`provider:check: ${fileName} does not declare ${DEFAULT_DENY_REGISTRAR_FUNCTION}`);
  }
  const names = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "name"
      && ts.isStringLiteralLike(node.initializer)
    ) {
      names.push(node.initializer.text);
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "it"
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      names.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(registrar.body);
  if (names.length === 0) {
    throw new Error(`provider:check: ${DEFAULT_DENY_REGISTRAR_FUNCTION} registers no recognizable tests`);
  }
  return [...new Set(names)];
}

/**
 * Runs the given repo-relative test files in one vitest process and returns
 * the JSON reporter's per-file assertion results keyed by relative path.
 */
export async function runDefaultDenySuites({ rootDir, files }) {
  if (files.length === 0) {
    return new Map();
  }
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-default-deny-"));
  const outputFile = path.join(outputDir, "report.json");
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST")),
    );
    env[DEFAULT_DENY_FILES_ENV] = JSON.stringify(files);
    const vitestCli = path.join(rootDir, "node_modules/vitest/vitest.mjs");
    const { code, stderr } = await runProcess(
      process.execPath,
      [vitestCli, "run", "--config", DEFAULT_DENY_VITEST_CONFIG, "--reporter=json", `--outputFile=${outputFile}`],
      { cwd: rootDir, env },
    );
    let report;
    try {
      report = JSON.parse(await fs.readFile(outputFile, "utf8"));
    } catch {
      throw new Error(
        `provider:check: default-deny execution produced no vitest report (exit ${code}): ${stderr.slice(-2000)}`,
      );
    }
    const byFile = new Map(files.map((file) => [file, []]));
    for (const result of report.testResults ?? []) {
      const relative = path.relative(rootDir, result.name).split(path.sep).join("/");
      if (byFile.has(relative)) {
        byFile.get(relative).push(...(result.assertionResults ?? []).map((assertion) => ({
          title: assertion.title,
          status: assertion.status,
        })));
        // A failed hook or suite level error can fail the file while every assertion passed.
        if (result.status !== "passed") {
          byFile.get(relative).push({ title: DEFAULT_DENY_FILE_STATUS_TITLE, status: String(result.status) });
        }
      }
    }
    return byFile;
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

/** Problems for one suite: each expected test must be reported once as passed. */
export function defaultDenyExecutionProblems({ key, file, expected, assertions }) {
  const problems = [];
  for (const name of expected) {
    const statuses = assertions.filter((assertion) => assertion.title === name).map((assertion) => assertion.status);
    if (statuses.length === 0) {
      problems.push(`${key} default-deny test did not run: "${name}" (${file})`);
    } else if (!statuses.every((status) => status === "passed")) {
      problems.push(`${key} default-deny test did not pass: "${name}" is ${statuses.join(", ")} (${file})`);
    }
  }
  const failedFile = assertions.find((assertion) => assertion.title === DEFAULT_DENY_FILE_STATUS_TITLE);
  if (problems.length === 0 && failedFile) {
    problems.push(`${key} default-deny test file is ${failedFile.status} although its tests passed (${file})`);
  }
  return problems;
}

/**
 * Problems for a suite that names its own default-deny test (an adopted or API
 * adapter): at least one test must run and every reported test must pass.
 */
export function fullSuiteExecutionProblems({ key, file, assertions }) {
  if (assertions.length === 0) {
    return [`${key} default-deny suite ran no tests (${file})`];
  }
  return assertions
    .filter((assertion) => assertion.status !== "passed")
    .map((assertion) => `${key} default-deny test did not pass: "${assertion.title}" is ${assertion.status} (${file})`);
}

/** Executes every suite and throws when any expected default-deny test did not pass. */
export async function assertDefaultDenyExecuted({ rootDir, suites }) {
  if (suites.length === 0) {
    return { executed: [] };
  }
  const expected = suites.some((suite) => !suite.requireAllPassed)
    ? expectedDefaultDenyTestNames(await fs.readFile(path.join(rootDir, DEFAULT_DENY_REGISTRAR_SOURCE), "utf8"))
    : [];
  const results = await runDefaultDenySuites({ rootDir, files: suites.map((suite) => suite.file) });
  const problems = suites.flatMap((suite) => {
    const assertions = results.get(suite.file) ?? [];
    return suite.requireAllPassed
      ? fullSuiteExecutionProblems({ ...suite, assertions })
      : defaultDenyExecutionProblems({ ...suite, expected, assertions });
  });
  if (problems.length > 0) {
    throw new Error(problems.map((problem) => `provider:check: ${problem}`).join("\n"));
  }
  return {
    executed: suites.map((suite) => ({
      key: suite.key,
      file: suite.file,
      passed: suite.requireAllPassed ? (results.get(suite.file) ?? []).length : expected.length,
    })),
  };
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}
