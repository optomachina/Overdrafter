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
  mapBounded,
  maxTier,
  parseScreenArgs,
  prFilePaths,
  replay,
  screen,
} from "./jev-pr-screen.mjs";
import {
  FIXED_PATH,
  MARKER_CONTEXT,
  buildMarkerDescription,
  canonicalJson,
  hashQuestions,
  isValidSha,
  parseMarkerDescription,
  readMarker,
  readPrHeadSha,
  resolveTrustedExecutable,
  writeMarker,
  SCREENER_ID,
} from "./lib/jev-screen-marker.mjs";
import { JEV_MODEL } from "./jev-client.mjs";
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
const labelOf = (value) => (typeof value === "number" || value === undefined ? String(value) : JSON.stringify(value));
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

  it("logs marker hits with null latency", () => {
    const result = { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 250 };
    const recordMiss = decisionRecord({ pr: 100, sha: "a".repeat(40), deterministic: "low" }, result, new Date(0), { ...SKIP, markerHit: false });
    expect(recordMiss.latency_ms).toBe(250);
    expect(recordMiss.marker_hit).toBe(false);
    expect(recordMiss.marker_tier).toBeNull();
    const recordHit = decisionRecord({ pr: 101, sha: "a".repeat(40), deterministic: "low" }, result, new Date(0), { ...SKIP, markerHit: true, markerTier: "low" });
    expect(recordHit.latency_ms).toBeNull();
    expect(recordHit.marker_hit).toBe(true);
    expect(recordHit.marker_tier).toBe("low");
  });

  it("records caller and screener fields", () => {
    const result = { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 100 };
    const record = decisionRecord({ pr: 102, sha: "b".repeat(40), deterministic: "low" }, result, new Date(0), { ...SKIP, caller: "test_caller" });
    expect(record.caller).toBe("test_caller");
    expect(record.screener).toBe(SCREENER_ID);
  });

  it("replays a marker hit without lowering below the marker's tier", () => {
    const hit = { pr: 1, sha: "c", ok: true, deterministic: "low", final: "risky", marker_hit: true, marker_tier: "risky", jev: { tier: "low", confidence: 0.99 } };
    expect(replay([hit])).toEqual([{ pr: 1, sha: "c", before: "risky", after: "risky", changed: false }]);
  });

  it("runs at most the limit at once and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapBounded([5, 1, 4, 2, 3, 0, 6], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, value));
      inFlight -= 1;
      return value * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBe(3);
    expect(await mapBounded([], 4, async () => 1)).toEqual([]);
  });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const Q = hashQuestions(SCREEN_QUESTIONS);
const markerText = (fields = {}) =>
  buildMarkerDescription({ tier: "normal", jevTier: "normal", confidence: 0.9, pIncident: 0.1, model: JEV_MODEL, questionHash: Q, ...fields });
const status = (description, { context = MARKER_CONTEXT, state = "success", login = "optomachina" } = {}) => ({ context, state, description, creator: { login } });
const STATUSES_PATH = /^repos\/optomachina\/Overdrafter\/commits\/([0-9a-f]{40})\/statuses\?per_page=100$/;
const POST_PATH = /^repos\/optomachina\/Overdrafter\/statuses\/([0-9a-f]{40})$/;
const PULL_PATH = /^repos\/optomachina\/Overdrafter\/pulls\/(\d+)$/;
const field = (args, name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

/**
 * An in-memory GitHub standing in for gh: statuses per SHA (newest first) and
 * PR heads. Every call is recorded; nothing touches the network.
 */
function fakeGitHub({ statuses = {}, heads = {}, failWrites = false } = {}) {
  const store = Object.fromEntries(Object.entries(statuses).map(([sha, list]) => [sha, [...list]]));
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const path = args[1];
    const read = STATUSES_PATH.exec(path);
    if (read) return JSON.stringify(store[read[1]] ?? []);
    const post = POST_PATH.exec(path);
    if (post) {
      if (failWrites) throw new Error("HTTP 403");
      store[post[1]] = [status(field(args, "description"), { context: field(args, "context"), state: field(args, "state") }), ...(store[post[1]] ?? [])];
      return "{}";
    }
    const pull = PULL_PATH.exec(path);
    if (pull && heads[pull[1]]) return `${heads[pull[1]]}\n`;
    throw new Error(`HTTP 404 for ${args.join(" ")}`);
  };
  const io = {
    read: (sha, model, questionHash) => readMarker(sha, model, questionHash, { run }),
    write: (sha, marker) => writeMarker(sha, marker, { run }),
    headSha: (pr) => readPrHeadSha(pr, { run }),
  };
  const posts = () => calls.filter((args) => POST_PATH.test(args[1]));
  return { run, io, calls, store, posts };
}

/** A Jev stub that counts calls and answers tier at confidence. */
function countingJev(choice = "normal", confidence = 0.9, noul = 0.15) {
  const jev = { calls: 0 };
  jev.ask = async () => {
    jev.calls += 1;
    return { ok: true, model: JEV_MODEL, answers: { tier: { type: "choice", choice, confidence }, incident: { type: "noul", noul } }, latencyMs: 200 };
  };
  return jev;
}

const quiet = { log: "/dev/null", append: () => {}, warn: () => {} };
const readme = (pr = 846, sha = SHA) => ({ pr, sha, deterministic: "low", files: ["README.md"], title: "Docs" });

describe("jev screen marker", () => {
  it("hashes the whole question set, independent of key order", () => {
    const hash = hashQuestions(SCREEN_QUESTIONS);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hash).toBe(hashQuestions(SCREEN_QUESTIONS));
    expect(hash).not.toBe("0801abcf"); // the old hash, which ignored every nested field
    const changes = [
      { ...SCREEN_QUESTIONS, tier: { ...SCREEN_QUESTIONS.tier, instructions: "different" } },
      { ...SCREEN_QUESTIONS, tier: { ...SCREEN_QUESTIONS.tier, criteria: { ...SCREEN_QUESTIONS.tier.criteria, low: "x" } } },
      { ...SCREEN_QUESTIONS, incident: { ...SCREEN_QUESTIONS.incident, type: "choice" } },
    ];
    for (const changed of changes) expect(hashQuestions(changed)).not.toBe(hash);
    const reordered = { incident: SCREEN_QUESTIONS.incident, tier: { criteria: SCREEN_QUESTIONS.tier.criteria, instructions: SCREEN_QUESTIONS.tier.instructions, type: "choice" } };
    expect(hashQuestions(reordered)).toBe(hash);
    expect(canonicalJson({ b: [2, { d: 1, c: undefined }], a: "x" })).toBe('{"a":"x","b":[2,{"d":1}]}');
  });

  it("builds and parses marker descriptions", () => {
    const text = markerText({ tier: "risky", jevTier: "normal", confidence: 0.87654, pIncident: 0.12301, questionHash: "abc12345" });
    expect(text).toBe("v1 tier=risky jev=normal c=0.876 p=0.124 model=jev-1.13.0 q=abc12345 screener=mjs");
    expect(text.length).toBeLessThanOrEqual(140);
    expect(parseMarkerDescription(text)).toEqual({ version: "v1", tier: "risky", jevTier: "normal", confidence: 0.876, pIncident: 0.124, model: "jev-1.13.0", questionHash: "abc12345", screener: "mjs" });
    expect(parseMarkerDescription(markerText({ pIncident: null })).pIncident).toBeNull();
    for (const bad of ["v2 tier=low jev=low c=0.9 model=m q=h screener=mjs", "v1 tier=low", "v1 tier=Low jev=low c=0.9 model=m q=h screener=mjs", "v1 tier=low jev=low c=1.5 model=m q=h screener=mjs", "v1 tier=low jev=low model=m q=h screener=mjs", "", null]) {
      expect(parseMarkerDescription(bad), String(bad)).toBeNull();
    }
  });

  it("resolves gh only from the trusted directories, never PATH", () => {
    const executable = new Set(["/usr/local/bin/gh", "/opt/homebrew/bin/gh"]);
    const canExecute = (path) => executable.has(path);
    expect(resolveTrustedExecutable("gh", { canExecute })).toBe("/usr/local/bin/gh");
    expect(resolveTrustedExecutable("gh", { canExecute: () => false })).toBeNull();
    expect(resolveTrustedExecutable("../gh", { canExecute: () => true })).toBeNull();
    expect(FIXED_PATH).toBe("/usr/bin:/usr/local/bin:/opt/homebrew/bin");
  });

  it("reads a trusted marker for the key and ignores everything else", async () => {
    const github = fakeGitHub({
      statuses: {
        [SHA]: [
          status(markerText({ tier: "risky" }), { login: "mallory" }),
          status(markerText({ tier: "risky" }), { state: "pending" }),
          status(markerText({ tier: "risky" }), { context: "jev-screen/other" }),
          status(markerText({ tier: "risky", model: "jev-1.12.0" })),
          status(markerText({ tier: "risky", questionHash: "deadbeef" })),
          status(markerText({ tier: "risky" }).replace("screener=mjs", "screener=py")),
          status("v1 tier=risky garbage"),
          status(markerText({ tier: "low", jevTier: "low" })),
        ],
      },
    });
    expect(await readMarker(SHA, JEV_MODEL, Q, { run: github.run })).toEqual({ found: true, version: "v1", tier: "low", jevTier: "low", confidence: 0.9, pIncident: 0.1, model: JEV_MODEL, questionHash: Q, screener: "mjs" });
    // Reads the raw JSON (no --jq filter, which made gh exit 1 on the array).
    expect(github.calls).toEqual([["api", `repos/optomachina/Overdrafter/commits/${SHA}/statuses?per_page=100`]]);
  });

  it("takes the highest tier when several markers match", async () => {
    const github = fakeGitHub({ statuses: { [SHA]: [status(markerText({ tier: "normal" })), status(markerText({ tier: "risky" })), status(markerText({ tier: "low", jevTier: "low" }))] } });
    expect((await readMarker(SHA, JEV_MODEL, Q, { run: github.run })).tier).toBe("risky");
  });

  it("misses fail-safe on no marker, an invalid SHA, an API error or a bad response", async () => {
    const github = fakeGitHub({ statuses: { [SHA]: [status("all good", { context: "CodeRabbit" })] } });
    expect(await readMarker(SHA, JEV_MODEL, Q, { run: github.run })).toEqual({ found: false, reason: "no_marker" });
    expect(await readMarker(OTHER_SHA, JEV_MODEL, Q, { run: github.run })).toEqual({ found: false, reason: "no_marker" });
    expect(await readMarker("head", JEV_MODEL, Q, { run: github.run })).toEqual({ found: false, reason: "invalid_sha" });
    expect(github.calls).toHaveLength(2);
    const failing = () => {
      throw new Error("gh: HTTP 502");
    };
    expect(await readMarker(SHA, JEV_MODEL, Q, { run: failing })).toMatchObject({ found: false, reason: "api_error", error: "gh: HTTP 502" });
    expect(await readMarker(SHA, JEV_MODEL, Q, { run: () => "{}" })).toMatchObject({ found: false, reason: "api_error" });
    expect(await readMarker(SHA, JEV_MODEL, Q, { run: () => "not json" })).toMatchObject({ found: false, reason: "api_error" });
  });

  it("writes a success marker and fails open", async () => {
    const github = fakeGitHub();
    const marker = { tier: "risky", jevTier: "normal", confidence: 0.9, pIncident: 0.2, model: JEV_MODEL, questionHash: Q };
    expect(await writeMarker(SHA, marker, { run: github.run })).toEqual({ success: true });
    expect(github.calls).toEqual([
      ["api", `repos/optomachina/Overdrafter/statuses/${SHA}`, "-X", "POST", "-f", "state=success", "-f", `description=${markerText({ tier: "risky", pIncident: 0.2 })}`, "-f", "context=jev-screen"],
    ]);
    expect((await readMarker(SHA, JEV_MODEL, Q, { run: github.run })).tier).toBe("risky");
    expect(await writeMarker("abc123", marker, { run: github.run })).toEqual({ success: false, reason: "invalid_sha" });
    expect(await writeMarker(SHA, { ...marker, tier: "high" }, { run: github.run })).toEqual({ success: false, reason: "invalid_tier" });
    expect(await writeMarker(SHA, { ...marker, confidence: 1.2 }, { run: github.run })).toEqual({ success: false, reason: "invalid_probability" });
    expect(await writeMarker(SHA, { ...marker, model: "bad model" }, { run: github.run })).toEqual({ success: false, reason: "invalid_key" });
    expect(await writeMarker(SHA, marker, { run: fakeGitHub({ failWrites: true }).run })).toMatchObject({ success: false, reason: "api_error" });
  });

  it("reads a PR's head SHA, or null", async () => {
    const github = fakeGitHub({ heads: { 846: SHA.toUpperCase() } });
    expect(await readPrHeadSha(846, { run: github.run })).toBe(SHA);
    expect(await readPrHeadSha(847, { run: github.run })).toBeNull();
    expect(await readPrHeadSha(0, { run: github.run })).toBeNull();
    expect(github.calls).toEqual([
      ["api", "repos/optomachina/Overdrafter/pulls/846", "--jq", ".head.sha"],
      ["api", "repos/optomachina/Overdrafter/pulls/847", "--jq", ".head.sha"],
    ]);
  });

  it("screens once per head SHA: the second screen hits the marker and skips Jev", async () => {
    const github = fakeGitHub({ heads: { 846: SHA } });
    const jev = countingJev("normal", 0.9, 0.15);
    const [first] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
    expect(first).toMatchObject({ marker_hit: false, final: "normal", latency_ms: 200 });
    expect(github.posts()).toHaveLength(1);
    const [second] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(1);
    expect(second).toMatchObject({ marker_hit: true, marker_tier: "normal", final: "normal", latency_ms: null, model: JEV_MODEL });
    // The hit replays the stored answer, never a synthetic certainty.
    expect(second.jev).toEqual({ tier: "normal", confidence: 0.9, status: "accepted", pIncident: 0.15 });
    expect(github.posts()).toHaveLength(1);
  });

  it("misses when the model changed and screens again under the new model", async () => {
    const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [status(markerText({ tier: "low", jevTier: "low", model: "jev-1.12.0" }))] } });
    const jev = countingJev("normal");
    const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(1);
    expect(record).toMatchObject({ marker_hit: false, final: "normal" });
    const latest = parseMarkerDescription(github.store[SHA][0].description);
    expect(latest).toMatchObject({ model: JEV_MODEL, tier: "normal" });
  });

  it("misses when the question set changed", async () => {
    const oldQuestions = { ...SCREEN_QUESTIONS, tier: { ...SCREEN_QUESTIONS.tier, instructions: "older wording" } };
    const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [status(markerText({ tier: "low", jevTier: "low", questionHash: hashQuestions(oldQuestions) }))] } });
    const jev = countingJev("normal");
    const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(1);
    expect(record.marker_hit).toBe(false);
  });

  it("never lowers a tier on a hit", async () => {
    const jev = countingJev("low", 0.99);
    // The marker's own final tier is a floor.
    const riskyMarker = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [status(markerText({ tier: "risky", jevTier: "low", confidence: 0.99 }))] } });
    const [floor] = await screen([readme()], { ...quiet, ask: jev.ask, marker: riskyMarker.io });
    expect(floor).toMatchObject({ marker_hit: true, deterministic: "low", final: "risky" });
    // The local path tier still applies: a low marker cannot lower a migration.
    const lowMarker = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [status(markerText({ tier: "low", jevTier: "low", confidence: 0.99 }))] } });
    const [migration] = await screen([{ ...readme(), files: [MIGRATION_SQL] }], { ...quiet, ask: jev.ask, marker: lowMarker.io });
    expect(migration).toMatchObject({ marker_hit: true, deterministic: "risky", final: "risky" });
    // A stored confidence below the current floor is uncertain, so at least normal.
    const [stricter] = await screen([readme()], { ...quiet, ask: jev.ask, marker: lowMarker.io, minConfidence: 0.995 });
    expect(stricter).toMatchObject({ marker_hit: true, final: "normal" });
    expect(stricter.jev.status).toBe("uncertain");
    // A hit with a tier the reader does not know counts as risky.
    const odd = { read: async () => ({ found: true, tier: "unknown", jevTier: "low", confidence: 0.99, pIncident: null, model: JEV_MODEL }), write: async () => ({ success: true }), headSha: async () => SHA };
    const [unknown] = await screen([readme()], { ...quiet, ask: jev.ask, marker: odd });
    expect(unknown).toMatchObject({ marker_hit: true, marker_tier: "risky", final: "risky" });
    expect(jev.calls).toBe(0);
  });

  it("writes markers only for accepted answers, and a failed write keeps the result", async () => {
    const github = fakeGitHub({ heads: { 846: SHA } });
    const [uncertain] = await screen([readme()], { ...quiet, ask: countingJev("low", 0.4).ask, marker: github.io });
    expect(uncertain).toMatchObject({ final: "normal", marker_hit: false });
    const failed = async () => ({ ok: false, reason: "timeout" });
    await screen([readme()], { ...quiet, ask: failed, marker: github.io });
    expect(github.posts()).toHaveLength(0);

    const warnings = [];
    const broken = fakeGitHub({ heads: { 846: SHA }, failWrites: true });
    const [record] = await screen([readme()], { ...quiet, ask: countingJev("normal").ask, marker: broken.io, warn: (line) => warnings.push(line) });
    expect(record).toMatchObject({ ok: true, final: "normal", marker_hit: false });
    expect(warnings.join("\n")).toMatch(/marker write for #846 failed \(api_error\)/);
  });

  it("uses a marker only when the SHA is the PR's current head", async () => {
    const warnings = [];
    const marked = { [SHA]: [status(markerText({ tier: "low", jevTier: "low" }))] };
    const stale = fakeGitHub({ heads: { 846: OTHER_SHA }, statuses: marked });
    const jev = countingJev("normal");
    const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: stale.io, warn: (line) => warnings.push(line) });
    expect(record.marker_hit).toBe(false);
    expect(jev.calls).toBe(1);
    expect(stale.calls.map((args) => args[1])).toEqual(["repos/optomachina/Overdrafter/pulls/846"]);
    expect(warnings.join("\n")).toMatch(/is not the PR head/);

    const unknownHead = fakeGitHub({ statuses: marked });
    await screen([readme()], { ...quiet, ask: jev.ask, marker: unknownHead.io });
    expect(unknownHead.posts()).toHaveLength(0);
    expect(jev.calls).toBe(2);

    // No PR number or a short SHA: no GitHub call at all.
    const none = fakeGitHub({ heads: { 846: SHA }, statuses: marked });
    await screen([readme(0), readme(-1), readme(846, "abc123"), { ...readme(), pr: undefined }], { ...quiet, ask: jev.ask, marker: none.io });
    expect(none.calls).toEqual([]);
    expect(jev.calls).toBe(6);
  });

  it("treats a throwing marker reader or head lookup as a miss", async () => {
    const boom = async () => {
      throw new Error("boom");
    };
    const jev = countingJev("normal");
    const [readFails] = await screen([readme()], { ...quiet, ask: jev.ask, marker: { read: boom, write: async () => ({ success: true }), headSha: async () => SHA } });
    const [headFails] = await screen([readme()], { ...quiet, ask: jev.ask, marker: { read: boom, write: boom, headSha: boom } });
    expect([readFails.marker_hit, headFails.marker_hit, jev.calls]).toEqual([false, false, 2]);
  });
});
