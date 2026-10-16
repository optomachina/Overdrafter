// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAINTENANCE_BRANCH,
  MAINTENANCE_LABEL,
  detectDrift,
  extractAppRoutes,
  extractMarkdownReferences,
  normalizeRoute,
  parseArgs,
  readIgnore,
  renderMarkdown,
  resolveBinary,
  runDetector,
  selectMaintenancePr,
} from "./verify-skill-drift.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/verify-skill-drift.mjs");
const SKILL = ".agents/skills/verify-overdrafter";
const notIgnored = () => false;
const cliRun = (args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });

const roots = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRepo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ovd858-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const APP = `<Routes>
  <Route path="/" element={<Index />} />
  <Route path="/parts/:jobId" element={<ClientPart />} />
  <Route path="*" element={<NotFound />} />
</Routes>`;

const cleanRepo = (extra = {}) => ({
  "src/App.tsx": APP,
  "e2e/smoke.spec.ts": "",
  "e2e/helper.mjs": "",
  [`${SKILL}/SKILL.md`]: "Run `scripts/verify.sh` and see `e2e/helper.mjs`.\n```bash\nnode `does/not/exist.mjs`\n```\n",
  [`${SKILL}/scripts/verify.sh`]: "",
  [`${SKILL}/features/README.md`]: "- [Auth](./auth.md): sign in.\n",
  [`${SKILL}/features/auth.md`]: "Open `/` then reload `/parts/<id>`; drive `e2e/smoke.spec.ts` with `@playwright/test`.\n",
  ...extra,
});

describe("extraction", () => {
  it("normalizes route params from both the app and the map", () => {
    expect(normalizeRoute("/parts/:jobId")).toBe("/parts/:param");
    expect(normalizeRoute("/parts/<id>/")).toBe("/parts/:param");
    expect(normalizeRoute("/")).toBe("/");
  });

  it("reads absolute app routes and skips the catch-all", () => {
    expect(extractAppRoutes(`${APP}\n<Route\n  path="/internal/commercial/:organizationId"\n/>`)).toEqual([
      "/",
      "/internal/commercial/:organizationId",
      "/parts/:jobId",
    ]);
  });

  it("takes inline-code routes and paths, not fenced blocks, commands, globs or packages", () => {
    const refs = extractMarkdownReferences(
      "`/parts` `src/journeys` `./scripts/verify.sh` `npm run dev` `playwright/.auth/*.json` `@playwright/test` `?debug=1` `artifacts/x/<UTC stamp>/` `e2e/a.spec.ts`\n```\n`fenced/path.md`\n```",
    );
    expect(refs).toEqual({ routes: ["/parts"], paths: ["scripts/verify.sh", "src/journeys"] });
  });

  it("does not read absolute filesystem paths as app routes", () => {
    expect(extractMarkdownReferences("`/tmp/out` `/usr/bin` `/home/x` `/tmpl`").routes).toEqual(["/tmpl"]);
  });
});

describe("detectDrift", () => {
  const app = (over = {}) => ({ routes: ["/", "/parts/:jobId"], specs: ["e2e/smoke.spec.ts"], pathExists: () => true, ...over });
  const files = (over = {}) =>
    Object.entries({ "features/README.md": "[A](./auth.md)", "features/auth.md": "`/` `/parts/<id>` e2e/smoke.spec.ts", ...over })
      .filter(([, text]) => text !== null)
      .map(([name, text]) => ({ name, text }));

  it("is clean when every route, spec and path lines up", () => {
    const report = detectDrift({ skill: { files: files() }, app: app() });
    expect(report).toMatchObject({ status: "clean", findings: [], checked: { featureFiles: 1, appRoutes: 2, e2eSpecs: 1 } });
  });

  it("reports each drift kind once, sorted", () => {
    const report = detectDrift({
      skill: {
        files: files({
          "features/README.md": "[A](./auth.md) [G](./gone.md) [A](./auth.md)",
          "features/auth.md": "`/old` `/` e2e/smoke.spec.ts e2e/removed.spec.ts `src/moved.ts`",
          "features/orphan.md": "x",
          "scripts/feature-specs.mjs": '["e2e/removed.spec.ts"]',
        }),
      },
      app: app({ routes: ["/", "/parts/:jobId"], specs: ["e2e/smoke.spec.ts", "e2e/new.spec.ts"], pathExists: () => false }),
    });
    expect(report.status).toBe("drift");
    expect(report.findings.map((f) => `${f.kind} ${f.item} ${f.source}`)).toEqual([
      "dead-index-link features/gone.md features/README.md",
      "missing-path src/moved.ts features/auth.md",
      "stale-route /old features/auth.md",
      "stale-spec e2e/removed.spec.ts features/auth.md",
      "stale-spec e2e/removed.spec.ts scripts/feature-specs.mjs",
      "unindexed-feature features/orphan.md features/orphan.md",
      "unmapped-route /parts/:jobId src/App.tsx",
      "unmapped-spec e2e/new.spec.ts e2e",
    ]);
    expect(report.counts).toMatchObject({ "stale-spec": 2, "unmapped-route": 1 });
  });

  it("flags a map with no index", () => {
    const report = detectDrift({ skill: { files: files({ "features/README.md": null }) }, app: app() });
    expect(report.findings.map((f) => f.kind)).toEqual(["missing-index"]);
  });

  it("honors ignore patterns, including prefix wildcards", () => {
    const report = detectDrift({
      skill: { files: files({ "features/auth.md": "`/` `src/gone.ts`" }) },
      app: app({ routes: ["/", "/debug/a", "/parts/:jobId"], specs: ["e2e/smoke.spec.ts"], pathExists: () => false }),
      ignore: { routes: ["/debug/*", "/parts/:jobId"], specs: ["e2e/smoke.spec.ts"], paths: ["src/gone.ts"] },
    });
    expect(report.status).toBe("clean");
  });

  it("matches route ignores in normalized form for both stale and unmapped routes", () => {
    const stale = detectDrift({
      skill: { files: files({ "features/auth.md": "`/` `/parts/<id>` `/jobs/<id>` e2e/smoke.spec.ts" }) },
      app: app(),
      ignore: { routes: ["/jobs/:jobId"], specs: [], paths: [], runtimePaths: [] },
    });
    expect(stale.status).toBe("clean");
    const unmapped = detectDrift({
      skill: { files: files({ "features/auth.md": "`/` e2e/smoke.spec.ts" }) },
      app: app(),
      ignore: { routes: ["/parts/<id>"], specs: [], paths: [], runtimePaths: [] },
    });
    expect(unmapped.status).toBe("clean");
  });

  it("sorts findings by code unit, not locale", () => {
    const report = detectDrift({ skill: { files: files({ "features/auth.md": "`/` `/parts/<id>` `/b` `/B` e2e/smoke.spec.ts" }) }, app: app() });
    expect(report.findings.map((f) => f.item)).toEqual(["/B", "/b"]);
  });
});

describe("readIgnore", () => {
  it("requires a reason for every entry", () => {
    expect(readIgnore("")).toEqual({ routes: [], specs: [], paths: [], runtimePaths: [] });
    expect(readIgnore('{"routes":[{"pattern":"/debug/*","reason":"dev-only gallery"}]}').routes).toEqual(["/debug/*"]);
    expect(() => readIgnore('{"routes":[{"pattern":"/x","reason":" "}]}')).toThrow(/non-empty "reason"/);
    expect(() => readIgnore('{"specs":"e2e/a.spec.ts"}')).toThrow(/must be an array/);
  });
});

describe("selectMaintenancePr (at most one PR per run)", () => {
  const pr = (number, headRefName, labels = [], extra = {}) => ({ number, headRefName, labels, ...extra });

  it("creates only when the run changed something and no maintenance PR is open", () => {
    expect(selectMaintenancePr({ outcome: "changed", openPrs: [pr(5, "feature/x")] })).toEqual({
      action: "create", branch: MAINTENANCE_BRANCH, label: MAINTENANCE_LABEL, reason: "no open maintenance PR", duplicates: [],
    });
  });

  it("reuses the fixed-branch PR before a labelled one and lists the rest as duplicates", () => {
    const openPrs = [pr(3, "other", [{ name: MAINTENANCE_LABEL }]), pr(9, MAINTENANCE_BRANCH), pr(4, "again", [MAINTENANCE_LABEL])];
    expect(selectMaintenancePr({ outcome: "changed", openPrs })).toMatchObject({
      action: "update", pr: 9, branch: MAINTENANCE_BRANCH, duplicates: [3, 4],
    });
    expect(selectMaintenancePr({ outcome: "changed", openPrs: openPrs.slice(0, 1) })).toMatchObject({ action: "update", pr: 3, branch: "other" });
  });

  it("ignores closed and fork PRs", () => {
    const openPrs = [pr(1, MAINTENANCE_BRANCH, [], { state: "MERGED" }), pr(2, MAINTENANCE_BRANCH, [], { isCrossRepository: true })];
    expect(selectMaintenancePr({ outcome: "changed", openPrs }).action).toBe("create");
  });

  it("never opens or pushes for clean or blocked runs", () => {
    for (const outcome of ["clean", "blocked"]) {
      expect(selectMaintenancePr({ outcome, openPrs: [pr(9, MAINTENANCE_BRANCH)] })).toMatchObject({ action: "none", existing: 9 });
      expect(selectMaintenancePr({ outcome })).toMatchObject({ action: "none", existing: null });
    }
    expect(() => selectMaintenancePr({ outcome: "drift" })).toThrow(/unknown outcome/);
  });

  it("counts a PR returned by both the branch and label queries once", () => {
    const both = pr(9, MAINTENANCE_BRANCH, [MAINTENANCE_LABEL]);
    expect(selectMaintenancePr({ outcome: "changed", openPrs: [both, { ...both }] })).toMatchObject({ action: "update", pr: 9, duplicates: [] });
  });
});

describe("resolveBinary", () => {
  it("returns the first absolute match from the fixed dirs and never consults PATH", () => {
    const exists = (candidate) => candidate === "/bin/git" || candidate === "/usr/local/bin/git";
    expect(resolveBinary("git", { dirs: ["/usr/bin", "/bin", "/usr/local/bin"], exists })).toBe("/bin/git");
    expect(() => resolveBinary("git", { dirs: ["/nowhere"], exists: () => false })).toThrow(/git not found in \/nowhere/);
  });
});

describe("parseArgs", () => {
  it("rejects unknown flags instead of falling back to defaults", () => {
    expect(parseArgs(["--root", "x"], ["root"])).toEqual({ root: "x" });
    expect(() => parseArgs(["--skilldir", "x"], ["root", "skill-dir"])).toThrow(/unknown flag: --skilldir/);
  });
});

describe("runDetector and CLI", () => {
  it("no-ops with a clear message when the skill is absent", () => {
    const root = fixtureRepo({ "src/App.tsx": APP });
    const report = runDetector({ root, isIgnored: notIgnored });
    expect(report).toMatchObject({ status: "absent" });
    expect(renderMarkdown(report)).toContain("No skill at .agents/skills/verify-overdrafter");
    const cli = cliRun(["--root", root]);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("Status: **absent**");
  });

  it("reports drift, not absent, when the skill exists without features/", () => {
    const repo = cleanRepo();
    delete repo[`${SKILL}/features/README.md`];
    delete repo[`${SKILL}/features/auth.md`];
    const root = fixtureRepo(repo);
    const report = runDetector({ root, isIgnored: notIgnored });
    expect(report.status).toBe("drift");
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "missing-index", detail: expect.stringMatching(/no features\/ directory/) }));
    expect(cliRun(["--root", root]).status).toBe(1);
  });

  it("does not count paths that resolve outside the repo as present", () => {
    const repo = cleanRepo({ [`${SKILL}/features/auth.md`]: "`/` `/parts/<id>` e2e/smoke.spec.ts `../../../../../../etc/passwd`" });
    const report = runDetector({ root: fixtureRepo(repo), isIgnored: () => true });
    expect(report.findings.map((f) => `${f.kind} ${f.item}`)).toEqual(["missing-path ../../../../../../etc/passwd"]);
  });

  it("is clean on a consistent fixture repo and resolves skill-relative paths", () => {
    const report = runDetector({ root: fixtureRepo(cleanRepo()), isIgnored: notIgnored });
    expect(report.findings).toEqual([]);
    expect(renderMarkdown(report)).toContain("No drift found.");
  });

  it("treats only listed, gitignored runtime paths as present", () => {
    const repo = cleanRepo({
      [`${SKILL}/features/auth.md`]: "`/` `/parts/<id>` e2e/smoke.spec.ts `playwright/.auth/` `node_modules/made/up.js`",
      [`${SKILL}/drift-ignore.json`]: '{"runtimePaths":[{"pattern":"playwright/.auth/","reason":"e2e storage state"}]}',
    });
    const seen = [];
    const report = runDetector({ root: fixtureRepo(repo), isIgnored: (_, rel) => seen.push(rel) > 0 });
    expect(report.findings.map((f) => `${f.kind} ${f.item}`)).toEqual(["missing-path node_modules/made/up.js"]);
    expect(seen).toEqual(["playwright/.auth/"]);
  });

  it("escapes pipes and backticks in markdown table cells", () => {
    const md = renderMarkdown({
      status: "drift", skillDir: SKILL, checked: { featureFiles: 1, appRoutes: 0, e2eSpecs: 0 },
      findings: [{ kind: "missing-path", item: "a|b`c", source: "features/x.md", detail: "d" }],
    });
    expect(md).toContain("| missing-path | `a\\|b'c` | `features/x.md` | d |");
  });

  it("writes JSON and markdown reports and exits 1 on drift", () => {
    const root = fixtureRepo(cleanRepo({ "e2e/new.spec.ts": "", [`${SKILL}/drift-ignore.json`]: '{"routes":[{"pattern":"/","reason":"x"}]}' }));
    const cli = cliRun(["--root", root, "--json", path.join(root, "r.json"), "--markdown", path.join(root, "r.md")]);
    expect(cli.status).toBe(1);
    const report = JSON.parse(readFileSync(path.join(root, "r.json"), "utf8"));
    expect(report).toMatchObject({ schema: "ovd858.verify-skill-drift.v1", status: "drift", counts: { "unmapped-spec": 1 } });
    expect(readFileSync(path.join(root, "r.md"), "utf8")).toContain("| unmapped-spec | `e2e/new.spec.ts` | `e2e` |");
  });

  it("exits 2 on bad arguments or a malformed ignore file, and prints a PR decision", () => {
    expect(cliRun(["--root"]).status).toBe(2);
    const root = fixtureRepo(cleanRepo({ [`${SKILL}/drift-ignore.json`]: '{"routes":[{"pattern":"/"}]}' }));
    const bad = cliRun(["--root", root, "--json", path.join(root, "err.json"), "--markdown", path.join(root, "err.md")]);
    expect(bad.status).toBe(2);
    expect(JSON.parse(readFileSync(path.join(root, "err.json"), "utf8"))).toMatchObject({ status: "error", message: expect.stringMatching(/reason/) });
    expect(readFileSync(path.join(root, "err.md"), "utf8")).toContain("Status: **error**");
    const typo = cliRun(["--root", root, "--skilldir", "x"]);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain("unknown flag: --skilldir");
    expect(cliRun(["select-pr", "--outcome", "changed"]).status).toBe(2);
    expect(cliRun(["select-pr", "--outcome", "changed"]).stderr).toContain("needs --prs");
    writeFileSync(path.join(root, "prs.json"), JSON.stringify([{ number: 7, headRefName: MAINTENANCE_BRANCH, labels: [] }]));
    const cli = cliRun(["select-pr", "--outcome", "changed", "--prs", path.join(root, "prs.json")]);
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ action: "update", pr: 7 });
  });
});

describe("weekly workflow stays read-only", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/verify-skill-drift.yml"), "utf8");

  it("runs on a weekly cron and manual dispatch with read-only permissions", () => {
    expect(workflow).toMatch(/schedule:\n\s+- cron: '[^']+'/);
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
    expect(workflow).not.toMatch(/pull_request_target|secrets\.|write-all|: write\b|GITHUB_TOKEN|gh pr/);
  });

  it("only runs the detector and uploads its report", () => {
    const runs = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map((m) => m[1]);
    expect(runs).toEqual(["node scripts/verify-skill-drift.mjs --json verify-skill-drift.json --markdown verify-skill-drift.md"]);
    expect(workflow).toContain("uses: actions/upload-artifact@v4");
    expect(workflow).toContain("persist-credentials: false");
  });
});
