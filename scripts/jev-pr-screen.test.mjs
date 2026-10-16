// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOG,
  SENSITIVE_PATHS_UNAVAILABLE,
  decisionRecord,
  deterministicTier,
  finalTier,
  loadScreenSensitivePaths,
  maxTier,
  parseScreenArgs,
  replay,
  screen,
} from "./jev-pr-screen.mjs";
import { SENSITIVE_PATHS_FILE, loadSensitivePaths } from "./lib/sensitive-paths.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temps = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** A git repo whose HEAD^1 holds the repository's list and whose HEAD holds headText. */
function baseAndHeadRepo(headText, baseText = readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8")) {
  const dir = mkdtempSync(join(tmpdir(), "jev-base-ref-"));
  temps.push(dir);
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  git("init", "-q");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, SENSITIVE_PATHS_FILE), baseText);
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(join(dir, SENSITIVE_PATHS_FILE), headText);
  git("commit", "-qam", "head");
  return dir;
}

const withoutGlob = (glob) => {
  const config = JSON.parse(readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8"));
  config.globs = config.globs.filter((entry) => entry.glob !== glob);
  return JSON.stringify(config);
};

const accepted = (choice, confidence = 0.9) => ({ status: "accepted", choice, confidence });

describe("jev PR screen", () => {
  it("lets Jev raise the tier but never lower it", () => {
    expect(finalTier("low", accepted("risky"))).toBe("risky");
    expect(finalTier("risky", accepted("low"))).toBe("risky");
    expect(finalTier("normal", accepted("low"))).toBe("normal");
  });

  it("raises to at least normal when Jev fails or is unsure", () => {
    expect(finalTier("low", { status: "failed", reason: "timeout" })).toBe("normal");
    expect(finalTier("low", { status: "uncertain", choice: "low", confidence: 0.3 })).toBe("normal");
    expect(finalTier("risky", { status: "failed" })).toBe("risky");
  });

  it("treats an unknown Jev tier as normal and an unknown deterministic tier as risky", () => {
    expect(maxTier("normal", "low")).toBe("normal");
    expect(finalTier("low", accepted("bogus"))).toBe("normal");
    for (const typo of ["Risky", "critical", "high", undefined, null]) {
      expect(finalTier(typo, accepted("low"))).toBe("risky");
    }
    expect(decisionRecord({ pr: 9, sha: "f", deterministic: "Risky" }, { ok: false, reason: "timeout" }, new Date(0)))
      .toMatchObject({ deterministic: "risky", final: "risky" });
  });

  it("bounds what it logs", () => {
    const record = decisionRecord(
      { pr: "x", sha: "abc def/../../", deterministic: "low" },
      { ok: true, model: "jev 1.13.0 <script>", answers: { tier: { type: "choice", choice: "low", confidence: 7 }, incident: { type: "noul", noul: 3 } }, latencyMs: "slow" },
      new Date(0),
    );
    expect(record.pr).toBeNull();
    expect(record.sha).toMatch(/^[\w.-]*$/);
    expect(record.model).toMatch(/^[\w.-]*$/);
    expect(record.jev).toMatchObject({ confidence: null, pIncident: null, status: "failed" });
    expect(record.latencyMs).toBeNull();
    expect(record.final).toBe("normal");
  });

  it("records probabilities and failures without throwing", () => {
    const ok = decisionRecord(
      { pr: 1, sha: "a", deterministic: "low" },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 5 },
      new Date(0),
    );
    expect(ok).toMatchObject({ final: "low", jev: { tier: "low", confidence: 0.95, pIncident: 0.1 }, ok: true });
    const failed = decisionRecord({ pr: 2, sha: "b", deterministic: "low" }, { ok: false, reason: "http_403" }, new Date(0));
    expect(failed).toMatchObject({ final: "normal", ok: false, reason: "http_403", jev: { pIncident: null } });
  });

  it("replays logged decisions under a stricter confidence floor", () => {
    const records = [
      { pr: 4, sha: "d", ok: true, deterministic: "low", final: "low", jev: { tier: "low", confidence: 0.6 } },
      { pr: 5, sha: "e", ok: false, deterministic: "risky", final: "risky", jev: { tier: null, confidence: null } },
    ];
    expect(replay(records, { minConfidence: 0.5 })[0]).toMatchObject({ after: "low", changed: false });
    expect(replay(records, { minConfidence: 0.7 })[0]).toMatchObject({ after: "normal", changed: true });
    expect(replay(records, { minConfidence: 0.7 })[1]).toMatchObject({ after: "risky", changed: false });
    expect(replay(records, { minConfidence: 0.6 })[0]).toMatchObject({ after: "low" });
    expect(replay(records, { minConfidence: null })[0]).toMatchObject({ after: "low" });
    expect(replay(records, { minConfidence: 2 })[0]).toMatchObject({ after: "low" });
    const uncertain = [{ pr: 6, sha: "g", ok: true, deterministic: "low", final: "normal", jev: { tier: "low", confidence: 0.4 } }];
    expect(replay(uncertain, { minConfidence: 0.3 })[0]).toMatchObject({ after: "low", changed: true });
    const riskyBase = [{ pr: 7, sha: "h", ok: true, deterministic: "risky", final: "risky", jev: { tier: "low", confidence: 0.99 } }];
    expect(replay(riskyBase, { minConfidence: 0.1 })[0]).toMatchObject({ after: "risky", changed: false });
  });

  it("replays the committed log to itself at the default floor", () => {
    const lines = readFileSync(DEFAULT_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const result of replay(lines)) expect(result.changed).toBe(false);
  });

  it("raises the declared tier to risky for sensitive paths from the shared list, never lowers it", () => {
    const sensitivePaths = loadSensitivePaths({ root: fileURLToPath(new URL("..", import.meta.url)) });
    expect(deterministicTier({ deterministic: "low", files: ["README.md", ".github/workflows/ci.yml"] }, sensitivePaths))
      .toEqual({ tier: "risky", sensitiveClasses: ["infra_ci"] });
    expect(deterministicTier({ deterministic: "normal", files: ["README.md"] }, sensitivePaths)).toEqual({ tier: "normal", sensitiveClasses: [] });
    expect(deterministicTier({ deterministic: "Risky", files: ["README.md"] }, sensitivePaths).tier).toBe("risky");
    expect(deterministicTier({ deterministic: "low" })).toEqual({ tier: "low", sensitiveClasses: null });
  });

  it("appends one JSONL line per PR", async () => {
    const lines = [];
    const ask = async () => ({ ok: false, reason: "timeout", latencyMs: 1 });
    const records = await screen([{ pr: 3, sha: "c", deterministic: "risky" }], { ask, log: "x.jsonl", append: (_p, line) => lines.push(line) });
    expect(records[0].final).toBe("risky");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ pr: 3, final: "risky" });
    // The default screen reads docs/sensitive-paths.json, so a declared-low PR touching a lockfile is risky.
    const [lockfile] = await screen([{ pr: 4, sha: "d", deterministic: "low", files: ["package-lock.json"] }], { ask, log: "x.jsonl", append: () => {} });
    expect(lockfile).toMatchObject({ deterministic: "risky", sensitiveClasses: ["deps"], final: "risky" });
  });

  it("screens against the base ref's list, so a PR that narrows the list cannot lower its own tier", async () => {
    const ask = async () => ({ ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 });
    // The PR removes the .env glob and adds a .env file.
    const dir = baseAndHeadRepo(withoutGlob("**/.env*"));
    const pr = { pr: 5, sha: "e", deterministic: "low", files: [".env.production"] };
    const [fromBase] = await screen([pr], { ask, root: dir, baseRef: "HEAD^1", append: () => {} });
    expect(fromBase).toMatchObject({ deterministic: "risky", sensitiveClasses: ["secrets"], sensitivePathsUnavailable: false, final: "risky" });
    // The working tree (the PR's own list) is what --base-ref replaces.
    const [fromHead] = await screen([pr], { ask, root: dir, append: () => {} });
    expect(fromHead).toMatchObject({ deterministic: "low", sensitiveClasses: [], final: "low" });
  });

  it("fails closed to risky when the base list cannot be loaded", async () => {
    const ask = async () => ({ ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 });
    const pr = { pr: 6, sha: "f", deterministic: "low", files: ["README.md"] };
    const broken = baseAndHeadRepo(readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8"), "{ not json");
    // git would read "--output=<out>:docs/sensitive-paths.json" as an option and write that file.
    const output = join(broken, "out");
    mkdirSync(`${output}:docs`);
    for (const baseRef of ["no-such-ref", "HEAD^1", `--output=${output}`]) {
      expect(loadScreenSensitivePaths({ root: broken, baseRef }), baseRef).toBe(SENSITIVE_PATHS_UNAVAILABLE);
      const [record] = await screen([pr], { ask, root: broken, baseRef, append: () => {} });
      expect(record, baseRef).toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "risky" });
    }
    // An option-like ref is never handed to git.
    expect(existsSync(`${output}:${SENSITIVE_PATHS_FILE}`)).toBe(false);
    expect(deterministicTier({ deterministic: "low" }, SENSITIVE_PATHS_UNAVAILABLE)).toEqual({ tier: "risky", sensitiveClasses: null });
  });

  it("parses --base-ref on the command line", () => {
    expect(parseScreenArgs(["--base-ref", "origin/main", "in.json"])).toEqual({ input: "in.json", log: DEFAULT_LOG, baseRef: "origin/main" });
    expect(parseScreenArgs(["in.json", "out.jsonl"])).toEqual({ input: "in.json", log: "out.jsonl", baseRef: null });
    for (const argv of [[], ["--base-ref"], ["--base-ref", "--x", "in.json"], ["--nope", "in.json"], ["a", "b", "c"]]) {
      expect(() => parseScreenArgs(argv), argv.join(" ")).toThrow(/usage/);
    }
  });
});
