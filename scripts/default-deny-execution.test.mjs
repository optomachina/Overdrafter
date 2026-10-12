// @vitest-environment node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_DENY_REGISTRAR_SOURCE,
  assertDefaultDenyExecuted,
  defaultDenyExecutionProblems,
  expectedDefaultDenyTestNames,
  runDefaultDenySuites,
} from "./default-deny-execution.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEERG_FILE = "worker/src/adapters/weergProductionPortal.test.ts";
const QUICKPARTS_FILE = "worker/src/adapters/quickpartsProductionPortal.test.ts";
const DESCRIBE_OPEN = 'describe("Weerg production branch default-deny (OVD-675)", () => {\n';
const REGISTRAR_CALL = "  registerProductionPortalAuthorizationRefusals(defaultDenyHarness());\n";
const VITEST_IMPORT = 'import { afterEach, describe, expect, it, vi } from "vitest";\n';

function replaceOnce(source, from, to) {
  expect(source.split(from)).toHaveLength(2);
  return source.replace(from, to);
}

/** Closes the default-deny describe with a trailing options argument. */
function addTrailingDescribeOptions(source) {
  const start = source.indexOf(DESCRIBE_OPEN);
  const end = source.indexOf("\n});\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return `${source.slice(0, end)}\n}, { skip: true });\n${source.slice(end + "\n});\n".length)}`;
}

/**
 * Each mutation leaves the registrar call in the source while stopping the
 * default-deny tests from running and passing. Every one must fail the check.
 */
const MUTATIONS = [
  ["describe(name, { skip: true }, fn)", (source) => replaceOnce(
    source, DESCRIBE_OPEN, DESCRIBE_OPEN.replace("(OVD-675)\", ", "(OVD-675)\", { skip: true }, "),
  )],
  ["describe(name, { todo: true }, fn)", (source) => replaceOnce(
    source, DESCRIBE_OPEN, DESCRIBE_OPEN.replace("(OVD-675)\", ", "(OVD-675)\", { todo: true }, "),
  )],
  ["describe(name, fn, { skip: true })", addTrailingDescribeOptions],
  ["conditional return before the registrar", (source) => replaceOnce(
    source, `${DESCRIBE_OPEN}${REGISTRAR_CALL}`,
    `${DESCRIBE_OPEN}  if (process.env.OVD_UNSET_FLAG !== "set") {\n    return;\n  }\n${REGISTRAR_CALL}`,
  )],
  ["beforeEach((ctx) => ctx.skip())", (source) => replaceOnce(
    replaceOnce(source, VITEST_IMPORT, VITEST_IMPORT.replace("afterEach,", "afterEach, beforeEach,")),
    `${DESCRIBE_OPEN}${REGISTRAR_CALL}`,
    `${DESCRIBE_OPEN}  beforeEach((ctx) => ctx.skip());\n${REGISTRAR_CALL}`,
  )],
  ["vi.mock turns the registrar into a no-op", (source) => replaceOnce(
    source, VITEST_IMPORT,
    `${VITEST_IMPORT}vi.mock("../../test-support/productionPortalDefaultDeny", async (importOriginal) => ({\n`
      + "  ...(await importOriginal<object>()),\n"
      + "  registerProductionPortalAuthorizationRefusals: () => undefined,\n"
      + "}));\n",
  )],
  ["shadowed describe", (source) => replaceOnce(
    source, VITEST_IMPORT,
    `${VITEST_IMPORT.replace(" describe,", " describe as vitestDescribe,")}`
      + "const describe = (name: string, fn: () => void) => vitestDescribe.skip(name, fn);\n",
  )],
];

describe("default-deny execution proof", () => {
  const mutationFiles = new Map();
  let results;
  let expected;

  beforeAll(async () => {
    expected = expectedDefaultDenyTestNames(
      await fs.readFile(path.join(repoRoot, DEFAULT_DENY_REGISTRAR_SOURCE), "utf8"),
    );
    const original = await fs.readFile(path.join(repoRoot, WEERG_FILE), "utf8");
    const runId = randomUUID().slice(0, 8);
    await Promise.all(MUTATIONS.map(async ([label, mutate], index) => {
      // Same directory so relative imports resolve; `.mutation-*.ts` never
      // matches the unit lane's `*.test.ts` include.
      const file = `worker/src/adapters/weergProductionPortal.mutation-${runId}-${index}.ts`;
      const mutated = mutate(original);
      expect(mutated).not.toBe(original);
      await fs.writeFile(path.join(repoRoot, file), mutated);
      mutationFiles.set(label, file);
    }));
    results = await runDefaultDenySuites({
      rootDir: repoRoot,
      files: [WEERG_FILE, QUICKPARTS_FILE, ...mutationFiles.values()],
    });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([...mutationFiles.values()].map((file) => fs.rm(path.join(repoRoot, file), { force: true })));
  });

  it("reads the registrar's test names from the shared source", () => {
    expect(expected).toHaveLength(10);
    expect(expected).toContain("launches nothing and reads no session without a provider-dispatch authorization");
    expect(expected).toContain("refuses an expired or inconsistent permit lifetime");
  });

  it.each([["weerg", WEERG_FILE], ["quickparts", QUICKPARTS_FILE]])(
    "passes the checked-in %s default-deny suite",
    (key, file) => {
      expect(defaultDenyExecutionProblems({ key, file, expected, assertions: results.get(file) })).toEqual([]);
    },
  );

  it.each(MUTATIONS.map(([label]) => [label]))("fails when the default-deny suite is bypassed by %s", (label) => {
    const file = mutationFiles.get(label);
    const problems = defaultDenyExecutionProblems({ key: "weerg", file, expected, assertions: results.get(file) });
    expect(problems).toHaveLength(expected.length);
    expect(problems[0]).toMatch(/^weerg default-deny test did not (run|pass)/);
  });

  it("reports a test that ran but was skipped by status", () => {
    expect(defaultDenyExecutionProblems({
      key: "acme",
      file: "x.test.ts",
      expected: ["a", "b"],
      assertions: [{ title: "a", status: "passed" }, { title: "b", status: "skipped" }],
    })).toEqual(['acme default-deny test did not pass: "b" is skipped (x.test.ts)']);
  });

  it("does nothing when no reviewed provider has a default-deny file", async () => {
    await expect(assertDefaultDenyExecuted({ rootDir: repoRoot, suites: [] })).resolves.toEqual({ executed: [] });
  });
});
