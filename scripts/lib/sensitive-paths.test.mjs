// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASE_REF_UNAVAILABLE,
  BaseRefError,
  GATE_CODE_FILES,
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
  normalizePath,
  parseNameStatus,
  parseSensitivePaths,
  pathCandidates,
  readSensitivePathsText,
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

describe("OVD-1072 privileged entry points and import map", () => {
  const authPaths = [
    "supabase/functions/create-project-fallback/index.ts",
    "supabase/functions/dev-login/index.ts",
    "supabase/functions/engineering-interpretation/index.test.ts",
    "supabase/functions/engineering-interpretation/index.ts",
    "supabase/functions/engineering-worker-task/index.test.ts",
    "supabase/functions/engineering-worker-task/index.ts",
    "supabase/functions/engineering-worker/index.test.ts",
    "supabase/functions/engineering-worker/index.ts",
    "supabase/functions/engineering-worker/integration.ts",
    "supabase/functions/job-archive-fallback/authorization.ts",
    "supabase/functions/job-archive-fallback/delete-flow.ts",
    "supabase/functions/job-archive-fallback/index.ts",
    "supabase/functions/job-archive-fallback/query-fragments.ts",
    "supabase/functions/job-archive-fallback/nested/helper.ts",
    "supabase/functions/create-project-fallback/nested/helper.ts",
    "supabase/functions/dev-login/nested/helper.ts",
    "supabase/functions/engineering-interpretation/nested/helper.ts",
    "supabase/functions/engineering-worker/nested/helper.ts",
    "supabase/functions/engineering-worker-task/nested/helper.ts",
    "api/admin-operations.ts",
    "server/admin-operations/acceptance.test.ts",
    "server/admin-operations/budget.ts",
    "server/admin-operations/capability.test.ts",
    "server/admin-operations/contract.test.ts",
    "server/admin-operations/handler.ts",
    "server/admin-operations/implementation.test.ts",
    "server/admin-operations/projection.ts",
    "server/admin-operations/resolver-types.test.ts",
    "server/admin-operations/runtime.ts",
    "server/admin-operations/nested/helper.ts",
  ];

  it.each(authPaths)("classifies %s as auth", (file) => {
    expect(picomatchClasses(file)).toEqual(["auth"]);
    expect(classifyPaths([file], config).files[0].classes).toEqual(["auth"]);
  });

  it("classifies the service-role functions' import map as deps", () => {
    expect(picomatchClasses("supabase/functions/deno.json")).toEqual(["deps"]);
    expect(classifyPaths(["supabase/functions/deno.json"], config).files[0].classes).toEqual(["deps"]);
  });

  it.each([
    "api/admin-operations-helper.ts",
    "server/admin-operations-helper/runtime.ts",
    "server/engineering/interpret-prepared-request.ts",
    "src/lib/engineering-cumulative.ts",
    "supabase/functions/deno.jsonc",
    "supabase/functions/other/deno.json",
  ])("does not broaden coverage to %s", (file) => {
    expect(classifyPaths([file], config).files[0].classes).toEqual([]);
  });

  it("keeps these additions and their regression tests outside gate loosening", () => {
    const additions = [
      ...["job-archive-fallback", "create-project-fallback", "dev-login", "engineering-interpretation", "engineering-worker", "engineering-worker-task"].map((name) => `supabase/functions/${name}/**`),
      "api/admin-operations.ts", "server/admin-operations/**", "supabase/functions/deno.json",
    ];
    const baseText = withGlobs((globs) => {
      globs.splice(0, globs.length, ...globs.filter((entry) => !additions.includes(entry.glob)));
    });
    expect(findGateLoosening({
      baseText,
      headText: configText,
      changedFiles: ["AGENTS.md", SENSITIVE_PATHS_FILE, "scripts/lib/sensitive-paths.test.mjs"].map((file) => ({ status: "M", file })),
    })).toMatchObject({ detected: false, reasons: [] });
  });
});

describe("OVD-939 C2 gate coverage", () => {
  it.each([
    ["scripts/lib/jev-screen-marker.mjs", ["infra_ci"]],
    // jev-run-rate is named by no narrower glob; only scripts/lib/jev-* classifies it.
    ["scripts/lib/jev-run-rate.mjs", ["infra_ci"]],
    ["scripts/lib/jevx.mjs", []],
    ["scripts/validate-pr-body.mjs", ["infra_ci"]],
    ["scripts/ephemeral-db-apply.mjs", ["infra_ci"]],
    ["scripts/run-supabase-policy-tests.mjs", ["auth", "infra_ci"]],
    ["scripts/provider-kill.mjs", ["provider_dispatch", "infra_ci"]],
    ["scripts/staging-reset-guard.mjs", ["infra_ci"]],
    ["scripts/run-ovd418-production-release.sh", ["infra_ci"]],
    ["scripts/run-ovd418-staging-check.sh", []],
  ])("classifies %s with exactly its expected classes", (file, classes) => {
    expect(classifyPaths([file], config).files[0].classes).toEqual(classes);
    expect(picomatchClasses(file)).toEqual(classes);
  });

  it("uses distinct globs for second classes and detects removal of either one", () => {
    const secondClass = [
      ["scripts/run-supabase-policy-tests*", "auth", "scripts/run-supabase-policy-tests.mjs", "infra_ci"],
      ["scripts/provider-kill*", "provider_dispatch", "scripts/provider-kill.mjs", "infra_ci"],
    ];
    const globs = config.globs.map((entry) => entry.glob);
    expect(new Set(globs).size).toBe(globs.length);
    for (const [extraGlob, extraClass, exactGlob, exactClass] of secondClass) {
      expect(config.globs).toEqual(expect.arrayContaining([
        { glob: extraGlob, class: extraClass },
        { glob: exactGlob, class: exactClass },
      ]));
      for (const [glob, cls] of [[extraGlob, extraClass], [exactGlob, exactClass]]) {
        const without = withGlobs((list) => list.splice(0, list.length, ...list.filter((entry) => entry.glob !== glob)));
        expect(findGateLoosening({ baseText: without, headText: configText }).detected).toBe(false);
        expect(findGateLoosening({ baseText: configText, headText: without }).reasons)
          .toEqual([expect.objectContaining({ code: LOOSENING_GLOB_REMOVED, glob, class: cls })]);
      }
    }
  });

  it("depends on scripts/lib/jev-* for jev lib files no narrower glob names, and reports its removal", () => {
    const glob = "scripts/lib/jev-*";
    const path = "scripts/lib/jev-run-rate.mjs";
    expect(config.globs).toContainEqual({ glob, class: "infra_ci" });
    const without = withGlobs((list) => list.splice(0, list.length, ...list.filter((entry) => entry.glob !== glob)));
    expect(classifyPaths([path], parseSensitivePaths(without)).files[0].classes).toEqual([]);
    expect(findGateLoosening({ baseText: without, headText: configText }).detected).toBe(false);
    expect(findGateLoosening({ baseText: configText, headText: without }).reasons)
      .toEqual([expect.objectContaining({ code: LOOSENING_GLOB_REMOVED, glob, class: "infra_ci" })]);
  });

  it("still rejects a duplicate glob even when the class differs", () => {
    expect(() => parseSensitivePaths(withGlobs((list) => list.push({ glob: "scripts/provider-kill.mjs", class: "provider_dispatch" }))))
      .toThrow(/duplicate glob scripts\/provider-kill\.mjs/);
  });

  it("includes the new exact gate-code paths", () => {
    expect(GATE_CODE_FILES).toEqual(expect.arrayContaining([
      "scripts/validate-pr-body.mjs",
      "scripts/ephemeral-db-apply.mjs",
      "scripts/run-supabase-policy-tests.mjs",
    ]));
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

  it("runs the CLI when invoked through a symlinked directory (macOS /tmp is one)", () => {
    // node runs a symlinked script from its real path; the entry guard compares
    // realpaths, so the CLI neither does nothing nor exits 0 for a bad ref.
    const link = join(tempDir("sensitive-paths-link-"), "repo");
    symlinkSync(repoRoot, link, "dir");
    const script = join(link, MATCHER_PATH);
    const ok = spawnSync(process.execPath, [script, "classify", "--root", repoRoot, ".env.production", "docs/foo.md"], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(".env.production: secrets\ndocs/foo.md: -\n");
    const bad = spawnSync(process.execPath, [script, "classify", "--root", repoRoot, "--base-ref", "no-such-ref", ".env.production"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/does not resolve to a commit/);
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

  it("classifies the shared CLI entry-point guard and its test as infra_ci (OVD-950)", () => {
    const matcher = createMatcher(config);
    for (const file of ["scripts/lib/entry-point.mjs", "scripts/lib/entry-point.test.mjs"]) {
      expect(matcher.classify(file), file).toEqual(["infra_ci"]);
      expect(classifyPaths([file], config).files[0], file).toMatchObject({ path: file, classes: ["infra_ci"] });
    }
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

  it("keeps a backslash as a file-name character and also matches it read as a separator", () => {
    const matcher = createMatcher(config);
    // Git names are "/"-separated, so these are single file names at the root.
    for (const [file, name] of [[".env\\production", "secrets"], ["Dockerfile\\prod", "infra_ci"], ["docker-compose\\x.yml", "infra_ci"], ["requirements\\dev.txt", "deps"]]) {
      expect(matcher.classify(file), file).toEqual([name]);
      expect(picomatchClasses(file), `picomatch ${file}`).toEqual([name]);
      expect(classifyPaths([file], config).files[0], file).toMatchObject({ path: file, classes: [name] });
    }
    // Read with "\\" as separators too: a superset of picomatch on the raw name.
    const windowsMigration = [...MIGRATIONS_DIR.split("/"), "x.sql"].join("\\");
    expect(picomatchClasses(windowsMigration)).toEqual(["schema"]);
    expect(matcher.classify(windowsMigration)).toEqual(["schema", "migrations"]);
    expect(normalizePath(".env\\production")).toBe(".env\\production");
    expect(normalizePath("./a/b")).toBe("a/b");
    expect(normalizePath("/.//a")).toBe("a");
    expect(pathCandidates("a\\b\\.env")).toEqual(expect.arrayContaining(["a\\b\\.env", "a/b/.env"]));
  });

  it("matches every other reading of a path (trimmed, resolved, git-quoted)", () => {
    const matcher = createMatcher(config);
    for (const [file, name] of [
      [" .env", "secrets"],
      [".github//workflows/ci.yml", "infra_ci"],
      ["x/../.github/workflows/ci.yml", "infra_ci"],
      ["./.github/./workflows/ci.yml", "infra_ci"],
      ['"db/caf\\303\\251.sql"', "schema"],
      ['".github/workflows/tab\\tname.yml"', "infra_ci"],
    ]) {
      expect(matcher.classify(file), JSON.stringify(file)).toContain(name);
    }
    // Text that is not valid git quoting is matched as given.
    expect(matcher.classify('"a\\qb.sql"')).toEqual([]);
    expect(matcher.classify("src/lib/urls.ts")).toEqual([]);
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
    // Fixture paths with non-ASCII, tab, quote or backslash characters, plus a newline name.
    // A backslash is part of the name (git separates with "/"), so the report keeps it.
    const special = [
      ...fixture.filter((entry) => /[^\x20-\x7e]|["\\]/.test(entry.path)),
      { path: "db/back\\slash.sql", classes: ["schema"] },
      { path: [...MIGRATIONS_DIR.split("/"), "x.sql"].join("\\"), classes: ["schema", "migrations"] },
      { path: "cfg/new\nline/.env", classes: ["secrets"] },
    ];
    expect(special.filter((entry) => entry.path.includes("\\")).length).toBeGreaterThanOrEqual(6);
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
    for (const entry of special) expect(classesOf(entry.path), JSON.stringify(entry.path)).toEqual(entry.classes);
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
    // The fixture drops the trailing "## Agent graph" section so the injected glob
    // cannot also trip the 24 KiB budget; the real AGENTS.md budget is unchanged.
    const agents = agentsText
      .replace("`**/*.key`", "`**/*.key`, `**/*.p12`")
      .replace(/\n## Agent graph\n[\s\S]*$/, "\n");
    expect(agents).not.toContain("## Agent graph");
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

describe("import-boundary gate files", () => {
  const gateFiles = [
    "scripts/eslint-adapter-import-boundary.test.mjs",
    "server/design-graph/import-boundary.test.ts",
    "server/design-graph/import-boundary.ts",
    "src/features/jarvis/import-boundary.test.ts",
  ];
  const nearMisses = ["docs/important-boundaries.md", "src/boundary-notes.ts", "src/features/import-export.ts"];
  const withoutGlob = () =>
    withGlobs((globs) => {
      const index = globs.findIndex((entry) => entry.glob === "**/*import-boundary*");
      expect(index, "**/*import-boundary* must be in the config").toBeGreaterThanOrEqual(0);
      globs.splice(index, 1);
    });

  it("classifies the import-boundary gate files as infra_ci", () => {
    const matcher = createMatcher(config);
    // A path with "adapter" in its name is also provider_dispatch (the shared list fails closed on any adapter path).
    const alsoProviderDispatch = new Set(["scripts/eslint-adapter-import-boundary.test.mjs"]);
    for (const file of gateFiles) expect(matcher.classify(file), file).toEqual(alsoProviderDispatch.has(file) ? ["provider_dispatch", "infra_ci"] : ["infra_ci"]);
  });

  it("does not match near-miss paths", () => {
    const matcher = createMatcher(config);
    for (const file of nearMisses) expect(matcher.classify(file), file).toEqual([]);
  });

  it("treats adding the glob as a tightening, not gate loosening", () => {
    expect(findGateLoosening({ baseText: withoutGlob(), headText: configText })).toMatchObject({ detected: false, reasons: [] });
  });
});

describe("import-boundary gate coverage globs", () => {
  // Each added glob: paths it must classify as infra_ci, near misses it must not,
  // and that adding it alone is a tightening (never gate_loosening).
  const coverage = [
    {
      glob: "**/*import-boundary*/**",
      positives: ["src/import-boundary/rules.ts", "server/design-graph/import-boundary/index.ts", "import-boundary/a/b/c.ts", "src/Adapter-Import-Boundary/check.mjs"],
      negatives: ["src/import-boundaries-notes/rules.ts", "src/boundary/import/rules.ts", "src/import/boundary/rules.ts"],
    },
    {
      glob: "**/*import-boundaries*{,/**}",
      positives: ["scripts/import-boundaries.mjs", "src/import-boundaries/rules.ts", "src/Import-Boundaries.test.ts", "import-boundaries/a/b.ts"],
      negatives: ["docs/important-boundaries.md", "src/import-boundar.ts", "src/boundaries.ts"],
    },
    {
      glob: "**/*importboundary*{,/**}",
      positives: ["scripts/importBoundary.mjs", "src/importboundary.ts", "src/importBoundary/rules.ts", "src/ImportBoundaryCheck.test.ts"],
      negatives: ["src/importBoundar.ts", "src/import-boundary.ts", "src/importer/boundary.ts"],
    },
    {
      glob: "**/*importboundaries*{,/**}",
      positives: ["scripts/importBoundaries.mjs", "src/importboundaries.ts", "src/importBoundaries/rules.ts", "src/ImportBoundariesCheck.test.ts"],
      negatives: ["src/importBoundar.ts", "src/importer/boundaries.ts", "src/boundaries.ts"],
    },
    {
      glob: "**/*import_boundary*{,/**}",
      positives: ["scripts/import_boundary.py", "src/import_boundary.ts", "src/import_boundary/rules.ts", "src/IMPORT_BOUNDARY.test.ts"],
      negatives: ["src/import_bound.ts", "src/import_export.ts", "src/import/boundary.ts"],
    },
    {
      glob: "**/*import_boundaries*{,/**}",
      positives: ["scripts/import_boundaries.py", "src/import_boundaries.ts", "src/import_boundaries/rules.ts", "src/IMPORT_BOUNDARIES.test.ts"],
      negatives: ["src/import_bound.ts", "src/import_export.ts", "src/boundaries.ts"],
    },
    {
      glob: "server/design-graph/index.ts",
      positives: ["server/design-graph/index.ts", "./server/design-graph/index.ts", "Server/Design-Graph/Index.ts"],
      negatives: ["server/design-graph/types.ts", "server/design-graph/index.test.ts", "server/design-graph/sub/index.ts", "src/server/design-graph/index.ts"],
    },
    {
      glob: "server/jarvis/design-graph-port.ts",
      positives: ["server/jarvis/design-graph-port.ts", "./server/jarvis/design-graph-port.ts", "Server/Jarvis/Design-Graph-Port.ts"],
      negatives: ["server/jarvis/design-graph-port.test.ts", "server/jarvis/index.ts", "server/design-graph-port.ts", "src/server/jarvis/design-graph-port.ts"],
    },
  ];
  const withoutOnly = (glob) => withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === glob), 1));

  it("lists every coverage glob in the config as infra_ci", () => {
    for (const { glob } of coverage) expect(config.globs, glob).toContainEqual({ glob, class: "infra_ci" });
  });

  for (const { glob, positives, negatives } of coverage) {
    describe(glob, () => {
      const only = () => createMatcher({ ...config, globs: config.globs.filter((entry) => entry.glob === glob) });

      it("classifies its positive paths as infra_ci", () => {
        const matcher = createMatcher(config);
        for (const file of positives) {
          expect(only().classify(file), `${glob} should match ${file}`).toEqual(["infra_ci"]);
          // Other globs may add a class (an "adapter" name is also provider_dispatch); infra_ci must still be there.
          expect(matcher.classify(file), file).toContain("infra_ci");
        }
      });

      it("does not match its near-miss paths", () => {
        for (const file of negatives) expect(only().classify(file), `${glob} should not match ${file}`).toEqual([]);
      });

      it("agrees with picomatch on the positive and near-miss paths", () => {
        for (const file of [...positives, ...negatives].map(normalizePath)) {
          expect(only().isSensitive(file), file).toBe(picomatch(glob, PICOMATCH_OPTIONS)(file));
        }
      });

      it("is a tightening: adding it is not gate loosening", () => {
        const baseText = withoutOnly(glob);
        expect(JSON.parse(baseText).globs.some((entry) => entry.glob === glob)).toBe(false);
        expect(findGateLoosening({ baseText, headText: configText })).toMatchObject({ detected: false, reasons: [] });
      });

      it("is needed: without it no other glob classifies its positive paths", () => {
        const withoutIt = createMatcher(parseSensitivePaths(withoutOnly(glob)));
        for (const file of positives) expect(withoutIt.classify(file), `${glob} adds no infra_ci coverage for ${file}`).not.toContain("infra_ci");
      });
    });
  }

  it("classifies the DesignGraph entry files by exact path", () => {
    const matcher = createMatcher(config);
    for (const file of ["server/design-graph/index.ts", "server/jarvis/design-graph-port.ts"]) {
      expect(matcher.classify(file), file).toEqual(["infra_ci"]);
    }
  });

  it("keeps the original import-boundary glob and its class unchanged", () => {
    expect(config.globs).toContainEqual({ glob: "**/*import-boundary*", class: "infra_ci" });
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

  it("flags edits to the report runner, Jev screen, parity check, fixture and planned workflow", () => {
    expect(existsSync(join(repoRoot, REPORT_RUNNER_PATH))).toBe(true);
    // The workflow is a future card item, not in the repository yet.
    expect(existsSync(join(repoRoot, PLANNED_WORKFLOW_PATH))).toBe(false);
    expect(GATE_CODE_FILES).toEqual(expect.arrayContaining([MATCHER_PATH, REPORT_RUNNER_PATH, PLANNED_WORKFLOW_PATH, "scripts/jev-pr-screen.mjs", "scripts/validate-agent-contract.mjs"]));
    for (const file of GATE_CODE_FILES) {
      if (file !== PLANNED_WORKFLOW_PATH) expect(existsSync(join(repoRoot, file)), file).toBe(true);
      expect(codes(findGateLoosening({ changedFiles: [{ status: "M", file }] })), file).toEqual([LOOSENING_MATCHER_CHANGED]);
      expect(codes(findGateLoosening({ changedFiles: [{ status: "D", file }] })), file).toEqual([LOOSENING_MATCHER_CHANGED]);
      expect(findGateLoosening({ changedFiles: [{ status: "A", file }] }).detected, file).toBe(false);
    }
  });

  it("puts the files that control the list on the list, so editing any of them is sensitive", () => {
    const matcher = createMatcher(config);
    for (const file of [...GATE_CODE_FILES, SENSITIVE_PATHS_FILE, "AGENTS.md", "scripts/lib/sensitive-paths.test.mjs", "scripts/jev-client.mjs", "scripts/lib/jev-screen-marker.mjs", "scripts/validate-agent-contract.node-test.mjs"]) {
      expect(matcher.classify(file), file).toContain("infra_ci");
    }
    // A PR that edits only the matcher (or only the list and AGENTS.md) is sensitive.
    expect(classifyPaths([MATCHER_PATH], config)).toMatchObject({ sensitive: true, classes: ["infra_ci"] });
    expect(classifyPaths([SENSITIVE_PATHS_FILE, "AGENTS.md"], config)).toMatchObject({ sensitive: true, classes: ["infra_ci"] });
    // Adding these globs (OVD-873 round 3) did not loosen anything.
    const controlGlobs = [SENSITIVE_PATHS_FILE, "AGENTS.md", "scripts/lib/sensitive-paths*", "scripts/sensitive-paths*", "scripts/fixtures/sensitive-paths/**", "scripts/jev-pr-screen*", "scripts/jev-client*", "scripts/lib/jev-screen-marker*", "scripts/validate-agent-contract*"];
    expect(config.globs.filter((entry) => controlGlobs.includes(entry.glob))).toEqual(controlGlobs.map((glob) => ({ glob, class: "infra_ci" })));
    const before = withGlobs((globs) => globs.splice(0, globs.length, ...globs.filter((entry) => !controlGlobs.includes(entry.glob))));
    expect(findGateLoosening({ baseText: before, headText: configText })).toMatchObject({ detected: false, reasons: [] });
  });

  it("puts the agent graph and its validator on the list, so editing the merge gate spec is sensitive", () => {
    const graphFiles = [
      "docs/agent-graph/graph.v1.yaml",
      "docs/agent-graph/graph.schema.json",
      "docs/agent-graph/README.md",
      "scripts/validate-agent-graph.mjs",
      "scripts/validate-agent-graph.node-test.mjs",
    ];
    const matcher = createMatcher(config);
    for (const file of graphFiles) expect(matcher.classify(file), file).toContain("infra_ci");
    // A PR that edits only the graph (for example drops a merge gate requirement) is sensitive, not docs-only.
    expect(classifyPaths(["docs/agent-graph/graph.v1.yaml"], config)).toMatchObject({ sensitive: true, classes: ["infra_ci"] });
    // Adding these globs did not loosen anything.
    const graphGlobs = ["docs/agent-graph/**", "scripts/validate-agent-graph*"];
    expect(config.globs.filter((entry) => graphGlobs.includes(entry.glob))).toEqual(graphGlobs.map((glob) => ({ glob, class: "infra_ci" })));
    const before = withGlobs((globs) => globs.splice(0, globs.length, ...globs.filter((entry) => !graphGlobs.includes(entry.glob))));
    expect(findGateLoosening({ baseText: before, headText: configText })).toMatchObject({ detected: false, reasons: [] });
    // Removing either glob is gate_loosening.
    for (const glob of graphGlobs) {
      const without = withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === glob), 1));
      expect(findGateLoosening({ baseText: configText, headText: without }).reasons, glob).toEqual([expect.objectContaining({ code: LOOSENING_GLOB_REMOVED, glob })]);
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

  it("never falls back to the head list when an explicit --base-ref cannot be read", () => {
    // Base holds the list; the head drops the .env glob and adds a .env file.
    const dir = tempDir("sensitive-base-ref-");
    git(dir, "init", "-q");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), configText);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), withGlobs((globs) => globs.splice(globs.findIndex((entry) => entry.glob === "**/.env*"), 1)));
    writeFileSync(join(dir, ".env.production"), "PLACEHOLDER=1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "head");
    writeFileSync(join(dir, "changed.z"), git(dir, "diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"));

    // Library: an unresolvable, empty or option-like ref throws BaseRefError.
    for (const ref of ["no-such-ref", "", "  ", "-x", "HEAD~5"]) {
      expect(() => readSensitivePathsText({ root: dir, ref }), JSON.stringify(ref)).toThrow(BaseRefError);
      expect(() => loadSensitivePaths({ root: dir, ref }), JSON.stringify(ref)).toThrow(expect.objectContaining({ code: BASE_REF_UNAVAILABLE }));
    }
    expect(readSensitivePathsText({ root: dir, ref: "HEAD^1" })).toBe(configText);

    for (const ref of ["no-such-ref", ""]) {
      // classify: exit 2, nothing classified with the head list.
      const out = [];
      const err = [];
      expect(main(["classify", "--root", dir, "--base-ref", ref, ".env.production"], { stdout: (line) => out.push(line), stderr: (line) => err.push(line) }), JSON.stringify(ref)).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("\n")).toMatch(ref ? /does not resolve to a commit/ : /base ref is empty/);
      // report: exit 2, no report written.
      expect(main(["report", "--root", dir, "--changed-files-from", "changed.z", "--base-ref", ref, "--json-out", "bad.json"], { stdout: (line) => out.push(line), stderr: () => {} }), JSON.stringify(ref)).toBe(2);
      expect(out).toEqual([]);
      expect(existsSync(join(dir, "bad.json"))).toBe(false);
    }
    // As a process (an unset $BASE_SHA passes ""): exit 2.
    const proc = spawnSync(process.execPath, [libPath, "classify", "--root", dir, "--base-ref", "", ".env.production"], { encoding: "utf8" });
    expect(proc.status).toBe(2);
    expect(proc.stdout).toBe("");

    // A base that resolves classifies with the base list.
    const json = [];
    expect(main(["classify", "--root", dir, "--base-ref", "HEAD^1", "--json", ".env.production"], { stdout: (line) => json.push(line) })).toBe(0);
    expect(JSON.parse(json.join("\n"))).toMatchObject({ config_source: "base", classes: ["secrets"] });
  });

  it("uses the head list only when the base commit exists and has no list (the PR that adds it)", () => {
    const dir = tempDir("sensitive-introduce-");
    git(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base without the list");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, SENSITIVE_PATHS_FILE), configText);
    writeFileSync(join(dir, ".env.local"), "PLACEHOLDER=1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "head adds the list");
    writeFileSync(join(dir, "changed.z"), git(dir, "diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"));
    expect(readSensitivePathsText({ root: dir, ref: "HEAD^1" })).toBeNull();
    const lines = [];
    expect(main(["report", "--root", dir, "--changed-files-from", "changed.z", "--base-ref", "HEAD^1", "--json-out", "report.json"], { stdout: (line) => lines.push(line) })).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    expect(report.config_source).toBe("head");
    expect(report.files.find((file) => file.path === ".env.local").classes).toEqual(["secrets"]);
    expect(lines.join("\n")).toMatch(/config from head/);
  });

  it("returns 2 on usage errors", () => {
    const errors = [];
    expect(main(["report"], { stdout: () => {}, stderr: (line) => errors.push(line) })).toBe(2);
    expect(main(["nope"], { stdout: () => {}, stderr: (line) => errors.push(line) })).toBe(2);
    expect(errors).toHaveLength(2);
  });
});

// Gate scripts that were already unclassified when this test was added.
// Classify a new one in the same PR. Do not add it here.
const KNOWN_UNCLASSIFIED_GATE_SCRIPTS = [
  "scripts/check-compiled-worker-scope.mjs",
  "scripts/lint-cli-test-helpers.mjs",
  "scripts/verify-ovd372-pending-head.mjs",
  "scripts/verify-ovd373-applied-prefix.mjs",
  "scripts/verify-ovd373-database-target.mjs",
  "scripts/verify-ovd373-deployment-plan.mjs",
  "scripts/verify-ovd373-schema-fingerprint.mjs",
  "scripts/verify-ovd418-release-state.mjs",
  "scripts/verify-ovd635-ledger-manifest.mjs",
  "scripts/verify-removed-public-assets.mjs",
  "scripts/verify-snapshot-bucket-controls.mjs",
  "scripts/verify-xometry-recovery-host.mjs",
];

const isGateScript = (name) => {
  if (/\.(?:test|node-test)\.(?:mjs|sh)$/.test(name)) return false;
  return /^(?:check|validate|lint|guard|verify)-[^/]+\.(?:mjs|sh)$/.test(name) || name === "ci-rerun-once.mjs" || name === "preflight.sh";
};

const privilegedEnv = /SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|SUPABASE_DB_URL/;

function walkProductionSources(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkProductionSources(full, acc);
    else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx|mjs|js)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe("new gate and privileged files are classified", () => {
  const matcher = createMatcher(config);

  it("classifies the CI rerun gate and not its test", () => {
    expect(matcher.classify("scripts/ci-rerun-once.mjs")).toEqual(["infra_ci"]);
    expect(matcher.classify("scripts/ci-rerun-once.test.mjs")).toEqual([]);
  });

  it("fails when a new top-level gate script has no class", () => {
    const unclassified = readdirSync(join(repoRoot, "scripts"))
      .filter(isGateScript)
      .map((name) => `scripts/${name}`)
      .filter((file) => matcher.classify(file).length === 0)
      .sort();
    expect(unclassified).toEqual(KNOWN_UNCLASSIFIED_GATE_SCRIPTS);
  });

  it("fails when a privileged entry point has no auth or payments class", () => {
    const files = readdirSync(join(repoRoot, "supabase/functions"))
      .map((name) => join(repoRoot, "supabase/functions", name, "index.ts"))
      .filter((file) => existsSync(file));
    for (const root of ["api", "server"]) files.push(...walkProductionSources(join(repoRoot, root)));
    const missing = files
      .map((file) => relative(repoRoot, file))
      .filter((file) => privilegedEnv.test(readFileSync(join(repoRoot, file), "utf8")))
      .filter((file) => !matcher.classify(file).some((name) => name === "auth" || name === "payments"))
      .sort();
    expect(missing).toEqual([]);
  });
});
