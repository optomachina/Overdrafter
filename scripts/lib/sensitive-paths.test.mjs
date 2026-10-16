// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOOSENING_CONFIG_INVALID,
  LOOSENING_CONFIG_REMOVED,
  LOOSENING_GLOB_NARROWED,
  LOOSENING_GLOB_RECLASSIFIED,
  LOOSENING_GLOB_REMOVED,
  LOOSENING_MATCHER_CHANGED,
  MATCHER_PATH,
  PLANNED_WORKFLOW_PATH,
  REPORT_RUNNER_PATH,
  SENSITIVE_CLASSES,
  SENSITIVE_PATHS_FILE,
  checkAgentsParity,
  classifyPaths,
  compileGlob,
  createMatcher,
  findGateLoosening,
  globProblem,
  loadSensitivePaths,
  main,
  parseNameStatus,
  parseSensitivePaths,
  triageRoute,
  unquoteGitPath,
} from "./sensitive-paths.mjs";
import { decisionRecord } from "../jev-pr-screen.mjs";
import { validateAgentContract } from "../validate-agent-contract.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const libPath = fileURLToPath(new URL("./sensitive-paths.mjs", import.meta.url));
// picomatch is the semantic reference (a transitive dev install); the matcher itself stays dependency-free.
const picomatch = createRequire(import.meta.url)("picomatch");
const PICOMATCH_OPTIONS = { dot: true, nocase: true };

/** Fixture paths never name the migrations directory; map it here (as check-rls-deny-coverage.test.mjs does). */
const MIGRATIONS_DIR = ["supabase", "migrations"].join("/");
const fixture = JSON.parse(readFileSync(join(repoRoot, "scripts/fixtures/sensitive-paths/paths.json"), "utf8")).paths.map(
  (entry) => ({ ...entry, path: entry.path.replace("{migrations}", MIGRATIONS_DIR) }),
);

const config = loadSensitivePaths({ root: repoRoot });
const configText = readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8");
const agentsText = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");

const temps = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const picomatchClasses = (file, cfg = config) =>
  SENSITIVE_CLASSES.filter((name) => cfg.globs.some((entry) => entry.class === name && picomatch(entry.glob, PICOMATCH_OPTIONS)(file)));

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

const withGlobs = (mutate) => {
  const copy = JSON.parse(configText);
  mutate(copy.globs);
  return JSON.stringify(copy);
};

describe("sensitive-paths config", () => {
  it("is a valid document with exactly the shared classes", () => {
    expect(config.version).toBe(1);
    expect(Object.keys(config.classes).sort()).toEqual([...SENSITIVE_CLASSES].sort());
    for (const name of SENSITIVE_CLASSES) expect(config.globs.some((entry) => entry.class === name)).toBe(true);
  });

  it("rejects unknown classes, duplicates and unsupported glob syntax", () => {
    expect(() => parseSensitivePaths(withGlobs((globs) => globs.push({ glob: "x/**", class: "misc" })))).toThrow(/unknown class misc/);
    expect(() => parseSensitivePaths(withGlobs((globs) => globs.push({ ...globs[0] })))).toThrow(/duplicate glob/);
    for (const glob of ["src/[ab].ts", "!src/**", "/abs/**", "a//b", "a/../b", "+(a|b)", "{a}", "{a,b", "a\\b"]) {
      expect(globProblem(glob), glob).not.toBeNull();
    }
    expect(() => parseSensitivePaths({ ...JSON.parse(configText), version: 2 })).toThrow(/version must be 1/);
  });
});

describe("shared fixture", () => {
  it("covers about 40 paths and every class", () => {
    expect(fixture.length).toBeGreaterThanOrEqual(40);
    for (const name of SENSITIVE_CLASSES) expect(fixture.some((entry) => entry.classes.includes(name))).toBe(true);
    expect(fixture.some((entry) => entry.classes.length === 0)).toBe(true);
  });

  it("gives the same classification from every consumer", () => {
    const matcher = createMatcher(config);
    const batch = classifyPaths(fixture.map((entry) => entry.path), config);
    const cli = [];
    expect(main(["classify", "--root", repoRoot, "--json", ...fixture.map((entry) => entry.path)], { stdout: (line) => cli.push(line) })).toBe(0);
    const cliFiles = JSON.parse(cli.join("\n")).files;
    for (const [index, { path, classes }] of fixture.entries()) {
      // Reference semantics.
      expect(picomatchClasses(path), `picomatch ${path}`).toEqual(classes);
      // Matcher and batch classification.
      expect(matcher.classify(path), `matcher ${path}`).toEqual(classes);
      expect(batch.files[index], `batch ${path}`).toMatchObject({ path, classes });
      // CLI (what triage and shell gates call).
      expect(cliFiles[index], `cli ${path}`).toMatchObject({ path, classes });
      // Triage routing.
      expect(triageRoute([path], config), `triage ${path}`).toEqual({ route: classes.length ? "architect_first" : "standard", classes });
      // Jev PR screen deterministic tier.
      const record = decisionRecord({ pr: 1, sha: "a", deterministic: "low", files: [path] }, { ok: false, reason: "timeout" }, new Date(0), { sensitivePaths: config });
      expect(record, `jev ${path}`).toMatchObject({ deterministic: classes.length ? "risky" : "low", sensitiveClasses: classes });
    }
  });

  it("runs the CLI as a process with the same answer", () => {
    const sample = fixture.slice(0, 5);
    const out = execFileSync(process.execPath, [libPath, "classify", "--root", repoRoot, "--json", ...sample.map((entry) => entry.path)], { encoding: "utf8" });
    expect(JSON.parse(out).files.map((file) => file.classes)).toEqual(sample.map((entry) => entry.classes));
  });
});

describe("matcher semantics", () => {
  const extraPaths = [
    "a", "auth", "x/auth", "auth/x", ".github", ".github/workflows", "deep/.config/.env", "keys", "x/keys",
    "scripts/deploy", "scripts/deployment/x/y.sh", "supabase/config.toml.bak", "src/AUTH.ts", "token.yaml",
    "tokens.js", "token.txt", "rls", "src/curls.ts", "a_rls_b.sql", "Cargo.lock", "infra", "infra/x",
  ];

  it("matches picomatch {dot, nocase} for every glob and path", () => {
    for (const { glob } of config.globs) {
      const regex = compileGlob(glob);
      const reference = picomatch(glob, PICOMATCH_OPTIONS);
      for (const file of [...fixture.map((entry) => entry.path), ...extraPaths]) {
        expect(regex.test(file), `${glob} vs ${file}`).toBe(reference(file));
      }
    }
  });

  it("matches dotfiles and nested **/.env", () => {
    const matcher = createMatcher(config);
    for (const file of [".env", "a/.env", "a/b/c/.env", "a/b/.env.test", ".envrc", "./.env", "a\\b\\.env"]) {
      expect(matcher.classify(file), file).toContain("secrets");
    }
    expect(matcher.classify(".github/workflows/x.yml")).toEqual(["infra_ci"]);
    expect(matcher.classify("src/environment.ts")).toEqual([]);
    expect(compileGlob("**/.env").test("a/b/.env")).toBe(true);
    expect(compileGlob("**/.env").test(".env")).toBe(true);
    expect(compileGlob("**/.env").test("a/.envx")).toBe(false);
  });

  it("ignores case so renamed or upper-case paths still match", () => {
    const matcher = createMatcher(config);
    expect(matcher.classify("Supabase/Migrations/1_x.SQL")).toEqual(["schema", "migrations"]);
    expect(matcher.classify(".GITHUB/WORKFLOWS/CI.YML")).toEqual(["infra_ci"]);
    expect(matcher.classify("src/StripeClient.ts")).toEqual(["payments"]);
    expect(matcher.classify("Package.JSON")).toEqual(["deps"]);
  });

  it("matches camelCase and snake_case provider admission and upload paths", () => {
    const matcher = createMatcher(config);
    for (const file of ["worker/src/providerUploadCapability.ts", "worker/src/ProviderAdmissionGate.ts", "x/provider_upload/a.ts", "x/provider_admission.sql"]) {
      expect(matcher.classify(file), file).toContain("provider_dispatch");
    }
  });

  it("lets ** cross a newline in a name, where picomatch's does not (fail closed)", () => {
    const matcher = createMatcher(config);
    for (const [file, name] of [[".github/workflows/new\nline.yml", "infra_ci"], ["cfg/new\nline/.env", "secrets"], ["new\nline/a.sql", "schema"]]) {
      expect(matcher.classify(file), JSON.stringify(file)).toContain(name);
    }
    expect(picomatch(".github/workflows/**", PICOMATCH_OPTIONS)(".github/workflows/new\nline.yml")).toBe(false);
  });
});

describe("name-status parsing", () => {
  it("reads NUL-separated -z output, including rename and copy pairs", () => {
    expect(parseNameStatus("M\0db/caf\u00e9.sql\0A\0.github/workflows/tab\tname.yml\0R100\0scripts/lib/sensitive-paths.mjs\0x.mjs\0C75\0a.ts\0b.ts\0D\0q\"x.sql\0")).toEqual([
      { status: "M", file: "db/caf\u00e9.sql" },
      { status: "A", file: ".github/workflows/tab\tname.yml" },
      { status: "D", file: MATCHER_PATH },
      { status: "A", file: "x.mjs" },
      { status: "A", file: "b.ts" },
      { status: "D", file: 'q"x.sql' },
    ]);
    expect(() => parseNameStatus("M\0a.ts\0b.ts\0")).toThrow(/expected a status/);
    expect(() => parseNameStatus("R100\0a.ts\0")).toThrow(/missing its path/);
  });

  it("unquotes the names git quotes in newline output", () => {
    const quoted = [
      'A\t".github/workflows/caf\\303\\251.yml"',
      'A\t".github/workflows/tab\\tname.yml"',
      'A\t"cfg/new\\nline/.env"',
      'A\t"db/quote\\"name.sql"',
      "M\tplain.txt",
      "bare.md",
    ].join("\n");
    expect(parseNameStatus(quoted)).toEqual([
      { status: "A", file: ".github/workflows/caf\u00e9.yml" },
      { status: "A", file: ".github/workflows/tab\tname.yml" },
      { status: "A", file: "cfg/new\nline/.env" },
      { status: "A", file: 'db/quote"name.sql' },
      { status: "M", file: "plain.txt" },
      { status: "M", file: "bare.md" },
    ]);
    expect(unquoteGitPath('"a\\\\b"')).toBe("a\\b");
    expect(() => unquoteGitPath('"a\\qb"')).toThrow(/bad escape/);
  });

  it("reports names git would quote as sensitive (end to end through git diff -z)", () => {
    // Fixture paths with non-ASCII, tab or quote characters, plus a backslash and a newline name.
    const special = [
      ...fixture.filter((entry) => /[^\x20-\x7e]|"/.test(entry.path)),
      { path: "db/back\\slash.sql", expect: "db/back/slash.sql", classes: ["schema"] },
      { path: "cfg/new\nline/.env", classes: ["secrets"] },
    ];
    expect(special.length).toBeGreaterThanOrEqual(6);
    const dir = tempDir("sensitive-quoted-");
    git(dir, "init", "-q");
    mkdirSync(join(dir, dirname(SENSITIVE_PATHS_FILE)), { recursive: true });
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), configText);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    for (const { path } of special) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), "x\n");
    }
    writeFileSync(join(dir, "plain.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "head");
    writeFileSync(join(dir, "changed.z"), git(dir, "diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"));

    expect(main(["report", "--root", dir, "--changed-files-from", "changed.z", "--base-ref", "HEAD^1", "--json-out", "report.json"], { stdout: () => {} })).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    const classesOf = (file) => report.files.find((entry) => entry.path.normalize("NFC") === file.normalize("NFC"))?.classes;
    for (const entry of special) expect(classesOf(entry.expect ?? entry.path), JSON.stringify(entry.path)).toEqual(entry.classes);
    expect(classesOf("plain.txt")).toEqual([]);
    expect(report.files).toHaveLength(special.length + 1);
    // Newline output (git quotes these names there) gives the same files once unquoted.
    writeFileSync(join(dir, "changed.txt"), git(dir, "diff", "--name-status", "--no-renames", "HEAD^1", "HEAD"));
    expect(main(["report", "--root", dir, "--changed-files-from", "changed.txt", "--base-ref", "HEAD^1", "--json-out", "lines.json"], { stdout: () => {} })).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "lines.json"), "utf8")).files).toEqual(report.files);
  });
});

describe("AGENTS.md parity", () => {
  it("holds for the repository", () => {
    expect(checkAgentsParity(agentsText, config)).toEqual([]);
    expect(validateAgentContract(repoRoot)).toEqual([]);
  });

  const contractCopy = ({ agents = agentsText, json = configText } = {}) => {
    const dir = tempDir("sensitive-parity-");
    mkdirSync(join(dir, "docs"));
    for (const file of ["CLAUDE.md", "WORKFLOW.md"]) copyFileSync(join(repoRoot, file), join(dir, file));
    writeFileSync(join(dir, "AGENTS.md"), agents);
    if (json !== null) writeFileSync(join(dir, SENSITIVE_PATHS_FILE), json);
    return dir;
  };

  it("fails when the JSON has a glob AGENTS.md lacks", () => {
    const json = withGlobs((globs) => globs.push({ glob: "**/*.p12", class: "secrets" }));
    const errors = validateAgentContract(contractCopy({ json }));
    expect(errors).toEqual([expect.stringMatching(/\*\*\/\*\.p12 \(secrets\) is in docs\/sensitive-paths\.json but not in the AGENTS\.md list/)]);
  });

  it("fails when AGENTS.md has a glob the JSON lacks", () => {
    const agents = agentsText.replace("`**/*.key`", "`**/*.key`, `**/*.p12`");
    const errors = validateAgentContract(contractCopy({ agents }));
    expect(errors).toEqual([expect.stringMatching(/\*\*\/\*\.p12 \(secrets\) is in the AGENTS\.md list but not in docs\/sensitive-paths\.json/)]);
  });

  it("fails when a glob sits under a different class, the markers are gone, or the JSON is missing", () => {
    const moved = agentsText.replace(", `**/*.key`", "").replace("`**/package.json`", "`**/package.json`, `**/*.key`");
    expect(validateAgentContract(contractCopy({ agents: moved }))).toHaveLength(2);
    const unmarked = agentsText.replace("<!-- sensitive-paths:begin -->", "");
    expect(validateAgentContract(contractCopy({ agents: unmarked })).some((error) => error.includes("missing the"))).toBe(true);
    expect(validateAgentContract(contractCopy({ json: null }))).toContain(`${SENSITIVE_PATHS_FILE} is missing`);
  });
});

describe("gate loosening", () => {
  const migrationsGlob = `${MIGRATIONS_DIR}/**`;
  const codes = (result) => result.reasons.map((reason) => reason.code);

  it("does not flag an unchanged config or an added glob", () => {
    expect(findGateLoosening({ baseText: configText, headText: configText }).detected).toBe(false);
    const added = withGlobs((globs) => globs.push({ glob: "**/*.p12", class: "secrets" }));
    expect(findGateLoosening({ baseText: configText, headText: added })).toMatchObject({ detected: false, reasons: [] });
  });

  it("flags a narrowed glob", () => {
    const narrowed = withGlobs((globs) => {
      globs.find((entry) => entry.glob === migrationsGlob).glob = `${MIGRATIONS_DIR}/*.sql`;
    });
    const result = findGateLoosening({ baseText: configText, headText: narrowed });
    expect(result.detected).toBe(true);
    expect(result.reasons).toEqual([expect.objectContaining({ code: LOOSENING_GLOB_NARROWED, glob: migrationsGlob, class: "migrations" })]);
    expect(result.requires).toEqual(["grokbot_countersign", "blaine_card"]);
  });

  it("flags removed and reclassified globs, and a deleted or invalid file", () => {
    const removed = withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "**/.env*"), 1));
    expect(codes(findGateLoosening({ baseText: configText, headText: removed }))).toEqual([LOOSENING_GLOB_REMOVED]);
    const moved = withGlobs((globs) => {
      globs.find((entry) => entry.glob === "**/*.pem").class = "infra_ci";
    });
    expect(codes(findGateLoosening({ baseText: configText, headText: moved }))).toEqual([LOOSENING_GLOB_RECLASSIFIED]);
    expect(codes(findGateLoosening({ baseText: configText, headText: null }))).toEqual([LOOSENING_CONFIG_REMOVED]);
    expect(codes(findGateLoosening({ baseText: configText, headText: "{" }))).toEqual([LOOSENING_CONFIG_INVALID]);
  });

  it("flags edits to the matcher but not its introduction", () => {
    const edited = findGateLoosening({ changedFiles: [{ status: "M", file: MATCHER_PATH }] });
    expect(codes(edited)).toEqual([LOOSENING_MATCHER_CHANGED]);
    // The report runner runs the head copy, so the message must not claim which copy ran.
    expect(edited.reasons[0].message).toBe(`${MATCHER_PATH} edited; needs review`);
    expect(findGateLoosening({ changedFiles: [{ status: "A", file: MATCHER_PATH }] }).detected).toBe(false);
    expect(findGateLoosening({ baseText: null, headText: configText }).detected).toBe(false);
  });

  it("flags edits to the report runner and the planned workflow", () => {
    expect(existsSync(join(repoRoot, REPORT_RUNNER_PATH))).toBe(true);
    // The workflow is a future card item, not in the repository yet.
    expect(existsSync(join(repoRoot, PLANNED_WORKFLOW_PATH))).toBe(false);
    for (const file of [REPORT_RUNNER_PATH, PLANNED_WORKFLOW_PATH]) {
      expect(codes(findGateLoosening({ changedFiles: [{ status: "M", file }] }))).toEqual([LOOSENING_MATCHER_CHANGED]);
      expect(findGateLoosening({ changedFiles: [{ status: "A", file }] }).detected).toBe(false);
    }
  });

  it("classifies with the base checkout's JSON and reports loosening (report mode)", () => {
    const dir = tempDir("sensitive-report-");
    git(dir, "init", "-q");
    mkdirSync(join(dir, dirname(SENSITIVE_PATHS_FILE)), { recursive: true });
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), configText);
    writeFileSync(join(dir, "AGENTS.md"), agentsText);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    // The head drops the .env glob and adds a .env file in the same PR.
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "**/.env*"), 1)));
    writeFileSync(join(dir, ".env.local"), "PLACEHOLDER=1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "head");
    writeFileSync(join(dir, "changed.txt"), git(dir, "diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"));

    const lines = [];
    const exit = main(["report", "--root", dir, "--changed-files-from", "changed.txt", "--base-ref", "HEAD^1", "--json-out", "report.json"], { stdout: (line) => lines.push(line) });
    expect(exit).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    expect(report.config_source).toBe("base");
    expect(report.files.find((file) => file.path === ".env.local").classes).toEqual(["secrets"]);
    expect(report.gate_loosening).toMatchObject({ detected: true, reasons: [expect.objectContaining({ code: LOOSENING_GLOB_REMOVED, glob: "**/.env*" })] });
    expect(report.parity_errors).toEqual([expect.stringMatching(/\*\*\/\.env\* \(secrets\) is in the AGENTS\.md list but not in/)]);
    expect(lines.join("\n")).toMatch(/^GATE LOOSENING: needs Grok Bot countersign \+ Blaine's card \(report only, does not block\)/);
  });

  it("returns 2 on usage errors", () => {
    const errors = [];
    expect(main(["report"], { stdout: () => {}, stderr: (line) => errors.push(line) })).toBe(2);
    expect(main(["nope"], { stdout: () => {}, stderr: (line) => errors.push(line) })).toBe(2);
    expect(errors).toHaveLength(2);
  });
});
