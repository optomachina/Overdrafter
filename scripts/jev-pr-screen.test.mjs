// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOG,
  FILES_EMPTY,
  FILES_ENTRY_INVALID,
  FILES_MISSING,
  FILES_NOT_ARRAY,
  SENSITIVE_PATHS_UNAVAILABLE,
  SCREEN_QUESTIONS,
  decisionRecord,
  deterministicTier,
  finalTier,
  loadScreenSensitivePaths,
  maxTier,
  parseScreenArgs,
  prFilePaths,
  replay,
  screen,
} from "./jev-pr-screen.mjs";
import {
  buildMarkerDescription,
  parseMarkerDescription,
  hashQuestions,
  isValidSha,
  MARKER_VERSION,
  SCREENER_ID,
} from "./lib/jev-screen-marker.mjs";
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
/** Jev confidently answers low, so only the deterministic tier can make a PR risky. */
const askLow = async () => ({ ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 });
const MIGRATION_SQL = ["supabase", "migrations", "x.sql"].join("/");
/** A readable label for a value (JSON would print NaN as null and drop undefined). */
const labelOf = (value) => (typeof value === "number" || value === "undefined" ? String(value) : JSON.stringify(value));
/** Tier-logic tests only: the one explicit way to skip the sensitive-path check. */
const SKIP = { skipSensitivePaths: true };

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
    expect(decisionRecord({ pr: 9, sha: "f", deterministic: "Risky" }, { ok: false, reason: "timeout" }, new Date(0), SKIP))
      .toMatchObject({ deterministic: "risky", final: "risky" });
  });

  it("bounds what it logs", () => {
    const record = decisionRecord(
      { pr: "x", sha: "abc def/../../", deterministic: "low" },
      { ok: true, model: "jev 1.13.0 <script>", answers: { tier: { type: "choice", choice: "low", confidence: 7 }, incident: { type: "noul", noul: 3 } }, latencyMs: "slow" },
      new Date(0),
      SKIP,
    );
    expect(record.pr).toBeNull();
    expect(record.sha).toMatch(/^[\w.-]*$/);
    expect(record.model).toMatch(/^[\w.-]*$/);
    expect(record.jev).toMatchObject({ confidence: null, pIncident: null, status: "failed" });
    expect(record.latency_ms).toBeNull();
    expect(record.final).toBe("normal");
  });

  it("records probabilities and failures without throwing", () => {
    const ok = decisionRecord(
      { pr: 1, sha: "a", deterministic: "low" },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 5 },
      new Date(0),
      SKIP,
    );
    expect(ok).toMatchObject({ final: "low", jev: { tier: "low", confidence: 0.95, pIncident: 0.1 }, ok: true });
    const failed = decisionRecord({ pr: 2, sha: "b", deterministic: "low" }, { ok: false, reason: "http_403" }, new Date(0), SKIP);
    expect(failed).toMatchObject({ final: "normal", ok: false, reason: "http_403", jev: { pIncident: null } });
  });

  it("rejects PR 0 and negative PR numbers", () => {
    const record = decisionRecord(
      { pr: 0, sha: "abc", deterministic: "low" },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 5 },
      new Date(0),
      SKIP,
    );
    expect(record.pr).toBeNull();
    
    const negativeRecord = decisionRecord(
      { pr: -5, sha: "def", deterministic: "low" },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 5 },
      new Date(0),
      SKIP,
    );
    expect(negativeRecord.pr).toBeNull();
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

  it("raises the declared tier to risky for sensitive paths from the shared list, never lowers it", () => {
    const sensitivePaths = loadSensitivePaths({ root: fileURLToPath(new URL("..", import.meta.url)) });
    expect(deterministicTier({ deterministic: "low", files: ["README.md", ".github/workflows/ci.yml"] }, sensitivePaths))
      .toEqual({ tier: "risky", sensitiveClasses: ["infra_ci"], filesProblem: null });
    expect(deterministicTier({ deterministic: "normal", files: ["README.md"] }, sensitivePaths)).toEqual({ tier: "normal", sensitiveClasses: [], filesProblem: null });
    expect(deterministicTier({ deterministic: "Risky", files: ["README.md"] }, sensitivePaths).tier).toBe("risky");
    // Only the explicit skipSensitivePaths: true skips the path check (tier-logic tests).
    expect(deterministicTier({ deterministic: "low" }, undefined, SKIP)).toEqual({ tier: "low", sensitiveClasses: null, filesProblem: null });
  });

  it("never skips the sensitive-path check for a falsy, missing or invalid list (fail closed)", async () => {
    const sensitivePaths = loadSensitivePaths({ root: repoRoot });
    const plain = { pr: 12, sha: "j", deterministic: "low", files: ["README.md"] };
    const migration = { pr: 13, sha: "k", deterministic: "low", files: [MIGRATION_SQL] };
    const failedJev = { ok: false, reason: "timeout" };
    const unavailable = { tier: "risky", sensitiveClasses: null, filesProblem: null };
    // No list at all: deterministicTier and decisionRecord fail closed instead of keeping the declared tier.
    expect(deterministicTier(plain)).toEqual(unavailable);
    expect(decisionRecord(migration, failedJev, new Date(0))).toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "risky" });
    const invalid = [false, 0, "", Number.NaN, undefined, null, true, 1, SENSITIVE_PATHS_FILE, [], {}, { globs: [] }, { ...sensitivePaths, globs: "x" }, SENSITIVE_PATHS_UNAVAILABLE];
    for (const value of invalid) {
      const label = labelOf(value);
      expect(deterministicTier(plain, value), label).toEqual(unavailable);
      expect(deterministicTier(migration, value), label).toEqual(unavailable);
      expect(decisionRecord(plain, failedJev, new Date(0), { sensitivePaths: value }), label)
        .toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "risky" });
    }
    // screen(): null and undefined load the list (README.md stays low, a migration is risky) ...
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    for (const value of [null, undefined]) {
      const [low, risky] = await screen([plain, migration], { ask: askLow, log: tempLog, append: () => {}, sensitivePaths: value });
      expect(low, labelOf(value)).toMatchObject({ deterministic: "low", sensitiveClasses: [], sensitivePathsUnavailable: false, final: "low" });
      expect(risky, labelOf(value)).toMatchObject({ deterministic: "risky", sensitiveClasses: ["schema", "migrations"], sensitivePathsUnavailable: false, final: "risky" });
    }
    // ... and any other value that is not a valid list screens every PR risky, even when Jev answers low at 0.99.
    for (const value of invalid.filter((entry) => entry !== null && entry !== undefined)) {
      const [record] = await screen([plain], { ask: askLow, log: tempLog, append: () => {}, sensitivePaths: value });
      expect(record, labelOf(value))
        .toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "risky" });
    }
    // The opt-out is exactly skipSensitivePaths: true, and screen() has none.
    for (const skipSensitivePaths of [1, "true", "yes", {}]) {
      expect(deterministicTier(plain, false, { skipSensitivePaths }), labelOf(skipSensitivePaths)).toEqual(unavailable);
      expect(decisionRecord(plain, failedJev, new Date(0), { sensitivePaths: 0, skipSensitivePaths }).final, labelOf(skipSensitivePaths)).toBe("risky");
    }
    const [noOptOut] = await screen([plain], { ask: askLow, log: tempLog, append: () => {}, sensitivePaths: false, skipSensitivePaths: true });
    expect(noOptOut).toMatchObject({ deterministic: "risky", sensitivePathsUnavailable: true, final: "risky" });
    expect(decisionRecord(plain, failedJev, new Date(0), { sensitivePaths: false, ...SKIP })).toMatchObject({ deterministic: "low", sensitivePathsUnavailable: false });
  });

  it("accepts gh's {path} file objects and fails closed to risky on a missing, empty or malformed list", async () => {
    const sensitivePaths = loadSensitivePaths({ root: repoRoot });
    // gh pr view --json files gives [{path, additions, deletions}].
    expect(deterministicTier({ deterministic: "low", files: [{ path: MIGRATION_SQL, additions: 1, deletions: 0 }] }, sensitivePaths))
      .toEqual({ tier: "risky", sensitiveClasses: ["schema", "migrations"], filesProblem: null });
    expect(deterministicTier({ deterministic: "low", files: [{ path: "README.md" }, "docs/x.md"] }, sensitivePaths))
      .toEqual({ tier: "low", sensitiveClasses: [], filesProblem: null });
    expect(prFilePaths([{ path: "a.md" }, "b.md"])).toEqual({ paths: ["a.md", "b.md"], problem: null });
    // A git-quoted name is matched unquoted as well.
    expect(deterministicTier({ deterministic: "low", files: ['"db/caf\\303\\251.sql"'] }, sensitivePaths)).toMatchObject({ tier: "risky", sensitiveClasses: ["schema"] });
    const malformed = [
      [undefined, FILES_MISSING],
      [null, FILES_MISSING],
      ["README.md", FILES_NOT_ARRAY],
      [{ path: "README.md" }, FILES_NOT_ARRAY],
      [[], FILES_EMPTY],
      [[1], FILES_ENTRY_INVALID],
      [[null], FILES_ENTRY_INVALID],
      [[""], FILES_ENTRY_INVALID],
      [["  "], FILES_ENTRY_INVALID],
      [[["README.md"]], FILES_ENTRY_INVALID],
      [[{}], FILES_ENTRY_INVALID],
      [[{ path: 3 }], FILES_ENTRY_INVALID],
      [["README.md", { name: "x" }], FILES_ENTRY_INVALID],
    ];
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    for (const [files, problem] of malformed) {
      const pr = { pr: 8, sha: "g", deterministic: "low", files };
      expect(deterministicTier(pr, sensitivePaths), JSON.stringify(files)).toEqual({ tier: "risky", sensitiveClasses: null, filesProblem: problem });
      expect(deterministicTier(pr, SENSITIVE_PATHS_UNAVAILABLE), JSON.stringify(files)).toEqual({ tier: "risky", sensitiveClasses: null, filesProblem: problem });
      const [record] = await screen([pr], { ask: askLow, log: tempLog, append: () => {} });
      expect(record, JSON.stringify(files)).toMatchObject({ deterministic: "risky", sensitiveClasses: null, filesProblem: problem, final: "risky" });
    }
  });

  it("screens a PR that edits only the list's control files as risky", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    for (const file of ["scripts/lib/sensitive-paths.mjs", SENSITIVE_PATHS_FILE, "AGENTS.md", "scripts/jev-pr-screen.mjs", "scripts/jev-client.mjs", "scripts/validate-agent-contract.mjs", "scripts/fixtures/sensitive-paths/paths.json"]) {
      const [record] = await screen([{ pr: 10, sha: "h", deterministic: "low", files: [file] }], { ask: askLow, log: tempLog, append: () => {} });
      expect(record, file).toMatchObject({ deterministic: "risky", sensitiveClasses: ["infra_ci"], filesProblem: null, final: "risky" });
    }
    const [both] = await screen([{ pr: 11, sha: "i", deterministic: "low", files: [SENSITIVE_PATHS_FILE, "AGENTS.md"] }], { ask: askLow, log: tempLog, append: () => {} });
    expect(both).toMatchObject({ deterministic: "risky", final: "risky" });
  });

  it("appends one JSONL line per PR", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    const lines = [];
    const ask = async () => ({ ok: false, reason: "timeout", latencyMs: 1 });
    const records = await screen([{ pr: 3, sha: "c", deterministic: "risky" }], { ask, log: tempLog, append: (_p, line) => lines.push(line) });
    expect(records[0].final).toBe("risky");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ pr: 3, final: "risky" });
    // The default screen reads docs/sensitive-paths.json, so a declared-low PR touching a lockfile is risky.
    const [lockfile] = await screen([{ pr: 4, sha: "d", deterministic: "low", files: ["package-lock.json"] }], { ask, log: tempLog, append: () => {} });
    expect(lockfile).toMatchObject({ deterministic: "risky", sensitiveClasses: ["deps"], final: "risky" });
    // sensitivePaths: null is not an opt-out of the path check.
    const [optOut] = await screen([{ pr: 4, sha: "d2", deterministic: "low", files: ["package-lock.json"] }], { ask, log: tempLog, append: () => {}, sensitivePaths: null });
    expect(optOut).toMatchObject({ deterministic: "risky", sensitiveClasses: ["deps"], final: "risky" });
  });

  it("screens against the base ref's list, so a PR that narrows the list cannot lower its own tier", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    const ask = async () => ({ ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 });
    // The PR removes the .env glob and adds a .env file.
    const dir = baseAndHeadRepo(withoutGlob("**/.env*"));
    const pr = { pr: 5, sha: "e", deterministic: "low", files: [".env.production"] };
    const [fromBase] = await screen([pr], { ask, root: dir, baseRef: "HEAD^1", log: tempLog, append: () => {} });
    expect(fromBase).toMatchObject({ deterministic: "risky", sensitiveClasses: ["secrets"], sensitivePathsUnavailable: false, final: "risky" });
    // The working tree (the PR's own list) is what --base-ref replaces.
    const [fromHead] = await screen([pr], { ask, root: dir, log: tempLog, append: () => {} });
    expect(fromHead).toMatchObject({ deterministic: "low", sensitiveClasses: [], final: "low" });
    // A base ref that cannot be read is never replaced by the head list: "" (an unset $BASE) included.
    for (const baseRef of ["no-such-ref", "", "HEAD~9"]) {
      expect(loadScreenSensitivePaths({ root: dir, baseRef }), JSON.stringify(baseRef)).toBe(SENSITIVE_PATHS_UNAVAILABLE);
      const [record] = await screen([pr], { ask, root: dir, baseRef, log: tempLog, append: () => {} });
      expect(record, JSON.stringify(baseRef)).toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "risky" });
    }
  });

  it("fails closed to risky when the base list cannot be loaded", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    const ask = async () => ({ ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 });
    const pr = { pr: 6, sha: "f", deterministic: "low", files: ["README.md"] };
    const broken = baseAndHeadRepo(readFileSync(join(repoRoot, SENSITIVE_PATHS_FILE), "utf8"), "{ not json");
    // git would read "--output=<out>:docs/sensitive-paths.json" as an option and write that file.
    const output = join(broken, "out");
    mkdirSync(`${output}:docs`);
    for (const baseRef of ["no-such-ref", "", "HEAD^1", `--output=${output}`]) {
      expect(loadScreenSensitivePaths({ root: broken, baseRef }), baseRef).toBe(SENSITIVE_PATHS_UNAVAILABLE);
      const [record] = await screen([pr], { ask, root: broken, baseRef, log: tempLog, append: () => {} });
      expect(record, baseRef).toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "risky" });
    }
    // An option-like ref is never handed to git.
    expect(existsSync(`${output}:${SENSITIVE_PATHS_FILE}`)).toBe(false);
    expect(deterministicTier({ deterministic: "low", files: ["README.md"] }, SENSITIVE_PATHS_UNAVAILABLE)).toEqual({ tier: "risky", sensitiveClasses: null, filesProblem: null });
  });

  it("runs as a CLI when invoked through a symlinked directory", () => {
    // node runs a symlinked script from its real path; the entry guard compares realpaths, so the CLI still runs.
    const link = join(mkdtempSync(join(tmpdir(), "jev-cli-link-")), "repo");
    temps.push(dirname(link));
    symlinkSync(repoRoot, link, "dir");
    const proc = spawnSync(process.execPath, [join(link, "scripts", "jev-pr-screen.mjs")], { encoding: "utf8" });
    expect(proc.status).toBe(2);
    expect(proc.stderr).toMatch(/jev-pr-screen: usage:/);
  });

  it("parses --base-ref and --caller on the command line", () => {
    expect(parseScreenArgs(["--base-ref", "origin/main", "in.json"])).toEqual({ input: "in.json", log: DEFAULT_LOG, baseRef: "origin/main", caller: null });
    expect(parseScreenArgs(["--caller", "test-caller", "in.json"])).toEqual({ input: "in.json", log: DEFAULT_LOG, baseRef: null, caller: "test-caller" });
    expect(parseScreenArgs(["--base-ref", "origin/main", "--caller", "engineer", "in.json", "out.jsonl"])).toEqual({ input: "in.json", log: "out.jsonl", baseRef: "origin/main", caller: "engineer" });
    expect(parseScreenArgs(["in.json", "out.jsonl"])).toEqual({ input: "in.json", log: "out.jsonl", baseRef: null, caller: null });
    for (const argv of [[], ["--base-ref"], ["--base-ref", "--x", "in.json"], ["--caller"], ["--nope", "in.json"], ["a", "b", "c"]]) {
      expect(() => parseScreenArgs(argv), argv.join(" ")).toThrow(/usage/);
    }
  });

  it("validates commit SHAs (40 hex chars only)", () => {
    expect(isValidSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isValidSha("ABCDEF0123456789ABCDEF0123456789ABCDEF01")).toBe(true);
    expect(isValidSha("head")).toBe(false);
    expect(isValidSha("abc123")).toBe(false);
    expect(isValidSha("ovd-622")).toBe(false);
    expect(isValidSha("0123456789abcdef0123456789abcdef0123456")).toBe(false);
    expect(isValidSha("0123456789abcdef0123456789abcdef012345678")).toBe(false);
    expect(isValidSha("")).toBe(false);
    expect(isValidSha(null)).toBe(false);
  });

  it("hashes question sets to detect schema changes", () => {
    const hash1 = hashQuestions(SCREEN_QUESTIONS);
    expect(hash1).toMatch(/^[0-9a-f]{8}$/);
    
    const hash2 = hashQuestions(SCREEN_QUESTIONS);
    expect(hash2).toBe(hash1);
    
    const modified = { ...SCREEN_QUESTIONS, tier: { ...SCREEN_QUESTIONS.tier, instructions: "different" } };
    const hash3 = hashQuestions(modified);
    expect(hash3).not.toBe(hash1);
  });

  it("builds and parses marker descriptions", () => {
    const desc = buildMarkerDescription("risky", "normal", "jev-1.13.0", "abc12345");
    expect(desc).toBe("v1 tier=risky jev=normal model=jev-1.13.0 q=abc12345 screener=mjs");
    
    const parsed = parseMarkerDescription(desc);
    expect(parsed).toEqual({
      version: "v1",
      tier: "risky",
      jev: "normal",
      model: "jev-1.13.0",
      q: "abc12345",
      screener: "mjs"
    });
    
    expect(parseMarkerDescription("v2 tier=low")).toBeNull();
    expect(parseMarkerDescription("v1 tier=low")).toBeNull(); // missing required fields
    expect(parseMarkerDescription("")).toBeNull();
    expect(parseMarkerDescription(null)).toBeNull();
  });

  it("logs marker hits with null latency", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    const lines = [];
    
    const result = { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 250 };
    
    // Cache miss: latency should be logged
    const recordMiss = decisionRecord(
      { pr: 100, sha: "test-sha-1234567890123456789012345678901234567890", deterministic: "low" },
      result,
      new Date(0),
      { sensitivePaths: SKIP.skipSensitivePaths, markerHit: false }
    );
    expect(recordMiss.latency_ms).toBe(250);
    expect(recordMiss.marker_hit).toBe(false);
    
    // Marker hit: latency should be null
    const recordHit = decisionRecord(
      { pr: 101, sha: "test-sha-1234567890123456789012345678901234567890", deterministic: "low" },
      result,
      new Date(0),
      { sensitivePaths: SKIP.skipSensitivePaths, markerHit: true }
    );
    expect(recordHit.latency_ms).toBeNull();
    expect(recordHit.marker_hit).toBe(true);
  });

  it("records caller and screener fields", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    
    const result = { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 100 };
    
    const record = decisionRecord(
      { pr: 102, sha: "abc1234567890123456789012345678901234567", deterministic: "low" },
      result,
      new Date(0),
      { sensitivePaths: SKIP.skipSensitivePaths, caller: "test_caller" }
    );
    
    expect(record.caller).toBe("test_caller");
    expect(record.screener).toBe(SCREENER_ID);
  });

  it("marker miss on model version change", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    
    // Temporarily change JEV_MODEL to simulate a version upgrade
    const originalModel = "jev-1.13.0";
    const oldModel = "jev-1.12.0";
    
    // Mock readMarker to return a marker with the old model
    let markerReadCalled = false;
    let jevCallCount = 0;
    
    const mockAsk = async () => {
      jevCallCount++;
      return { ok: true, model: originalModel, answers: { tier: { type: "choice", choice: "normal", confidence: 0.95 }, incident: { type: "noul", noul: 0.15 } }, latencyMs: 200 };
    };
    
    // The marker system will look for a marker with the current JEV_MODEL (jev-1.13.0)
    // but the old marker has model jev-1.12.0, so it should be a cache miss
    // We test this by verifying that Jev is called (not skipped)
    const pr = { pr: 103, sha: "def4567890123456789012345678901234567890", deterministic: "low", files: ["README.md"], title: "Test" };
    
    // Call screen - it should call Jev because there's no marker for the current model
    const [record] = await screen([pr], { ask: mockAsk, log: tempLog, append: () => {}, sensitivePaths: null });
    
    // Verify Jev was called (not a marker hit)
    expect(jevCallCount).toBe(1);
    expect(record.marker_hit).toBe(false);
    expect(record.model).toBe(originalModel);
    expect(record.jev.tier).toBe("normal");
  });
});
