// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOG,
  FILES_EMPTY,
  FILES_ENTRY_INVALID,
  FILES_MISSING,
  FILES_NOT_ARRAY,
  SENSITIVE_PATHS_UNAVAILABLE,
  SCREEN_QUESTIONS,
  classifyFallback,
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
  MARKER_VERSION,
  MAX_DESCRIPTION_LENGTH,
  MAX_STATUS_PAGES,
  buildMarkerDescription,
  canonicalJson,
  hashQuestions,
  hashScreenState,
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

import { FILES_INCOMPLETE, verifiedPrFiles, localDiffFiles } from "./jev-pr-screen-files.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Every GitHub call in this file goes through an in-memory fake. As a backstop,
// a gh that slipped past the fakes would have no credentials and a host that
// cannot resolve, so it could never reach GitHub.
const GH_ENV_KEYS = ["GH_HOST", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const savedGhEnv = Object.fromEntries(GH_ENV_KEYS.map((key) => [key, process.env[key]]));
const isolatedGhConfig = mkdtempSync(join(tmpdir(), "jev-gh-none-"));
for (const key of GH_ENV_KEYS) delete process.env[key];
process.env.GH_HOST = "gh-guard.invalid";
process.env.GH_CONFIG_DIR = isolatedGhConfig;
afterAll(() => {
  for (const [key, value] of Object.entries(savedGhEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolatedGhConfig, { recursive: true, force: true });
});

// Legacy classification/logging tests use explicit synthetic acquisition. The
// authoritative transport and pre-PR boundaries are tested below with screen().
async function fixtureScreen(prs, options) {
  // Fallback WARNs are silenced by default; a test that wants them passes warn (undefined restores the stderr default).
  if (options.marker) return screen(prs, { files: () => acq(["README.md"]), warn: () => {}, ...options });
  const fixtures = prs.map((pr, index) => ({ ...pr, pr: pr.pr ?? index + 1, sha: SHA }));
  return screen(fixtures, {
    files: (number) => {
      const { paths, problem } = prFilePaths(fixtures.find((pr) => pr.pr === number).files);
      if (problem) throw new Error(problem);
      return acq(paths);
    },
    marker: { headSha: async () => SHA, read: async () => ({ found: false }), write: async () => ({ success: true }) },
    warn: () => {},
    ...options,
  });
}

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
  it("classifies fallback sources without changing tiers", () => {
    expect(classifyFallback({ ok: false, reason: "http_403" }, { status: "failed" })).toEqual({ source: "default_jev_blocked", reason: "http_403" });
    expect(classifyFallback({ ok: false, reason: "timeout" }, { status: "failed" })).toEqual({ source: "jev_blocked", reason: "timeout" });
    expect(classifyFallback({ ok: true }, { status: "uncertain", choice: "low", confidence: 0.2 })).toEqual({ source: "safe-default", reason: "uncertain" });
    expect(classifyFallback({ ok: true }, { status: "failed", reason: "malformed_answer" })).toEqual({ source: "jev_used:false", reason: "malformed_answer" });
    expect(classifyFallback({ ok: true }, { status: "accepted", choice: "low", confidence: 0.9 })).toEqual({ source: null, reason: null });
  });

  it("records latency_ms and fallback_reason on every decision row", () => {
    const failed = decisionRecord({ pr: 1, sha: "a", deterministic: "low" }, { ok: false, reason: "timeout", latencyMs: 9 }, new Date(0), SKIP);
    expect(failed).toMatchObject({ latency_ms: 9, fallback_reason: "timeout", fallback_source: "jev_blocked" });
    expect(failed).not.toHaveProperty("latencyMs");
    expect(failed.warning).toBe("WARN jev-fallback source=jev_blocked reason=timeout latencyMs=9");
    const ok = decisionRecord(
      { pr: 2, sha: "b", deterministic: "low" },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 5 },
      new Date(0),
      SKIP,
    );
    expect(ok).toMatchObject({ latency_ms: 5, fallback_reason: null, fallback_source: null, warning: null, final: "low" });
  });

  it("bounds a fallback reason to one sanitized token before it reaches the row or stderr", () => {
    expect(classifyFallback({ ok: false, reason: "bad reason\nWARN forged" }, { status: "failed" })).toEqual({ source: "jev_blocked", reason: "bad_reason_WARN_forged" });
    const record = decisionRecord({ pr: 1, sha: "a", deterministic: "low" }, { ok: false, reason: "x y\nz" }, new Date(0), SKIP);
    expect(record.fallback_reason).toBe("x_y_z");
    expect(record.warning).toBe("WARN jev-fallback source=jev_blocked reason=x_y_z latencyMs=null");
  });

  it("does not WARN for a cache hit that Jev answered confidently, and WARNs when a stricter floor rejects it", () => {
    const sha = "a".repeat(40);
    const result = { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.9 }, incident: { type: "noul", noul: 0 } }, latencyMs: null };
    const hit = decisionRecord({ pr: 1, sha, deterministic: "low" }, result, new Date(0), { ...SKIP, markerHit: true, markerTier: "low" });
    expect(hit).toMatchObject({ cache_hit: true, latency_ms: null, fallback_source: null, warning: null });
    const stricter = decisionRecord({ pr: 1, sha, deterministic: "low" }, result, new Date(0), { ...SKIP, markerHit: true, markerTier: "low", minConfidence: 0.99 });
    expect(stricter).toMatchObject({ fallback_source: "safe-default", fallback_reason: "uncertain", latency_ms: null, final: "no_verdict" });
  });

  it("emits WARN for each fallback source in screen and stays quiet on the normal path", async () => {
    const lines = [];
    const warnings = [];
    const queue = [
      { ok: false, reason: "http_403", latencyMs: 2 },
      { ok: false, reason: "timeout", latencyMs: 4 },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.1 }, incident: { type: "noul", noul: 0 } }, latencyMs: 3 },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 },
    ];
    const prs = queue.map((_, i) => ({ pr: 100 + i, sha: "s", deterministic: "low", files: ["README.md"] }));
    // The last PR has no verifiable file list, so it never reaches Jev and screens risky.
    prs[4] = { ...prs[4], files: [] };
    const records = await fixtureScreen(prs, { ask: async () => queue.shift(), append: (_path, line) => lines.push(line), warn: (line) => warnings.push(line) });
    expect(records.map((r) => r.fallback_source)).toEqual(["default_jev_blocked", "jev_blocked", "safe-default", null, "jev_blocked"]);
    expect(records.every((r) => Object.hasOwn(r, "latency_ms") && Object.hasOwn(r, "fallback_reason"))).toBe(true);
    expect(records[3]).toMatchObject({ fallback_reason: null, warning: null, latency_ms: 1 });
    expect(records[4]).toMatchObject({ fallback_reason: "files-incomplete", final: "no_verdict" });
    expect(warnings).toEqual([
      "WARN jev-fallback source=default_jev_blocked reason=http_403 latencyMs=2",
      "WARN jev-fallback source=jev_blocked reason=timeout latencyMs=4",
      "WARN jev-fallback source=safe-default reason=uncertain latencyMs=3",
      "WARN jev-fallback source=jev_blocked reason=files-incomplete latencyMs=null",
    ]);
    expect(JSON.parse(lines[3])).toMatchObject({ fallback_reason: null, latency_ms: 1 });
    expect(JSON.parse(lines[0]).warning).toBe(warnings[0]);
  });

  it.each([
    ["http_403", () => new Response("denied", { status: 403 }), "source=default_jev_blocked reason=http_403"],
    ["http_500", () => new Response("boom", { status: 500 }), "source=jev_blocked reason=http_500"],
    ["malformed_response", () => new Response("not json", { status: 200 }), "source=jev_blocked reason=malformed_response"],
    ["network", () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), "source=jev_blocked reason=network_ECONNREFUSED"],
  ])("writes exactly one WARN per failed Jev call over the real askJev (%s)", async (_name, respond, expected) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => respond()));
    try {
      const lines = [];
      // No ask is passed, so the screen runs over the real askJev (default ask) with a stubbed transport.
      const [record] = await fixtureScreen([{ pr: 1, sha: "a", deterministic: "low", files: ["README.md"] }], { append: (_path, line) => lines.push(line), warn: undefined });
      expect(fetch).toHaveBeenCalledOnce();
      expect(err).toHaveBeenCalledOnce();
      expect(err.mock.calls[0][0]).toMatch(new RegExp(`^WARN jev-fallback ${expected} latencyMs=\\d+$`));
      expect(err.mock.calls[0][0]).toBe(record.warning);
      expect(JSON.parse(lines[0]).warning).toBe(record.warning);
    } finally {
      err.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("asks Jev with its own stderr WARN off so the screen is the only writer", async () => {
    const ask = vi.fn(async () => ({ ok: false, reason: "timeout", latencyMs: 4 }));
    await fixtureScreen([{ pr: 1, sha: "a", deterministic: "low", files: ["README.md"] }], { ask, append: () => {} });
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][2]).toMatchObject({ timeoutMs: 20_000, warn: false });
  });

  it("sends the screen-level WARN to stderr by default", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fixtureScreen([{ pr: 1, sha: "a", deterministic: "low", files: ["README.md"] }], { ask: async () => ({ ok: false, reason: "http_403", latencyMs: 2 }), append: () => {}, warn: undefined });
      expect(err).toHaveBeenCalledExactlyOnceWith("WARN jev-fallback source=default_jev_blocked reason=http_403 latencyMs=2");
    } finally {
      err.mockRestore();
    }
  });

  it("lets Jev raise the tier but never lower it", () => {
    expect(finalTier("low", accepted("risky"))).toBe("risky");
    expect(finalTier("risky", accepted("low"))).toBe("risky");
    expect(finalTier("normal", accepted("low"))).toBe("normal");
  });

  it("gives no verdict (fails closed) when Jev fails or is unsure", () => {
    expect(finalTier("low", { status: "failed", reason: "timeout" })).toBe("no_verdict");
    expect(finalTier("low", { status: "uncertain", choice: "low", confidence: 0.3 })).toBe("no_verdict");
    expect(finalTier("risky", { status: "failed" })).toBe("no_verdict");
  });

  it("gives no verdict for an unknown Jev tier and an unknown deterministic tier as risky", () => {
    expect(maxTier("normal", "low")).toBe("normal");
    expect(finalTier("low", accepted("bogus"))).toBe("no_verdict");
    for (const typo of ["Risky", "critical", "high", undefined, null]) {
      expect(finalTier(typo, accepted("low"))).toBe("risky");
    }
    expect(decisionRecord({ pr: 9, sha: "f", deterministic: "Risky" }, { ok: false, reason: "timeout" }, new Date(0), SKIP))
      .toMatchObject({ deterministic: "risky", final: "no_verdict" });
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
    expect(record.final).toBe("no_verdict");
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
    expect(failed).toMatchObject({ final: "no_verdict", ok: false, reason: "http_403", jev: { pIncident: null } });
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
    expect(replay(records, { minConfidence: 0.7 })[0]).toMatchObject({ after: "no_verdict", changed: true });
    expect(replay(records, { minConfidence: 0.7 })[1]).toMatchObject({ after: "no_verdict", changed: true });
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
    expect(decisionRecord(migration, failedJev, new Date(0))).toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "no_verdict" });
    const invalid = [false, 0, "", Number.NaN, undefined, null, true, 1, SENSITIVE_PATHS_FILE, [], {}, { globs: [] }, { ...sensitivePaths, globs: "x" }, SENSITIVE_PATHS_UNAVAILABLE];
    for (const value of invalid) {
      const label = labelOf(value);
      expect(deterministicTier(plain, value), label).toEqual(unavailable);
      expect(deterministicTier(migration, value), label).toEqual(unavailable);
      expect(decisionRecord(plain, failedJev, new Date(0), { sensitivePaths: value }), label)
        .toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "no_verdict" });
    }
    // screen(): null and undefined load the list (README.md stays low, a migration is risky) ...
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    for (const value of [null, undefined]) {
      const [low, risky] = await fixtureScreen([plain, migration], { ask: askLow, log: tempLog, append: () => {}, sensitivePaths: value });
      expect(low, labelOf(value)).toMatchObject({ deterministic: "low", sensitiveClasses: [], sensitivePathsUnavailable: false, final: "low" });
      expect(risky, labelOf(value)).toMatchObject({ deterministic: "risky", sensitiveClasses: ["schema", "migrations"], sensitivePathsUnavailable: false, final: "risky" });
    }
    // ... and any other value that is not a valid list screens every PR risky, even when Jev answers low at 0.99.
    for (const value of invalid.filter((entry) => entry !== null && entry !== undefined)) {
      const [record] = await fixtureScreen([plain], { ask: askLow, log: tempLog, append: () => {}, sensitivePaths: value });
      expect(record, labelOf(value))
        .toMatchObject({ deterministic: "risky", sensitiveClasses: null, sensitivePathsUnavailable: true, final: "risky" });
    }
    // The opt-out is exactly skipSensitivePaths: true, and screen() has none.
    for (const skipSensitivePaths of [1, "true", "yes", {}]) {
      expect(deterministicTier(plain, false, { skipSensitivePaths }), labelOf(skipSensitivePaths)).toEqual(unavailable);
      expect(decisionRecord(plain, failedJev, new Date(0), { sensitivePaths: 0, skipSensitivePaths }).final, labelOf(skipSensitivePaths)).toBe("no_verdict");
    }
    const [noOptOut] = await fixtureScreen([plain], { ask: askLow, log: tempLog, append: () => {}, sensitivePaths: false, skipSensitivePaths: true });
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
      const [record] = await fixtureScreen([pr], { ask: askLow, log: tempLog, append: () => {} });
      expect(record, JSON.stringify(files)).toMatchObject({ deterministic: "risky", sensitiveClasses: null, filesProblem: FILES_INCOMPLETE, final: "no_verdict" });
    }
  });

  it("screens a PR that edits only the list's control files as risky", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    for (const file of ["scripts/lib/sensitive-paths.mjs", SENSITIVE_PATHS_FILE, "AGENTS.md", "scripts/jev-pr-screen.mjs", "scripts/jev-client.mjs", "scripts/validate-agent-contract.mjs", "scripts/fixtures/sensitive-paths/paths.json"]) {
      const [record] = await fixtureScreen([{ pr: 10, sha: "h", deterministic: "low", files: [file] }], { ask: askLow, log: tempLog, append: () => {} });
      expect(record, file).toMatchObject({ deterministic: "risky", sensitiveClasses: ["infra_ci"], filesProblem: null, final: "risky" });
    }
    const [both] = await fixtureScreen([{ pr: 11, sha: "i", deterministic: "low", files: [SENSITIVE_PATHS_FILE, "AGENTS.md"] }], { ask: askLow, log: tempLog, append: () => {} });
    expect(both).toMatchObject({ deterministic: "risky", final: "risky" });
  });

  it("appends one JSONL line per PR", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    const lines = [];
    const ask = async () => ({ ok: false, reason: "timeout", latencyMs: 1 });
    const records = await fixtureScreen([{ pr: 3, sha: "c", deterministic: "risky" }], { ask, log: tempLog, append: (_p, line) => lines.push(line) });
    expect(records[0].final).toBe("no_verdict");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ pr: 3, final: "no_verdict" });
    // The default screen reads docs/sensitive-paths.json, so a declared-low PR touching a lockfile is risky.
    const [lockfile] = await fixtureScreen([{ pr: 4, sha: "d", deterministic: "low", files: ["package-lock.json"] }], { ask, log: tempLog, append: () => {} });
    expect(lockfile).toMatchObject({ deterministic: "risky", sensitiveClasses: ["deps"], final: "no_verdict" });
    // sensitivePaths: null is not an opt-out of the path check.
    const [optOut] = await fixtureScreen([{ pr: 4, sha: "d2", deterministic: "low", files: ["package-lock.json"] }], { ask, log: tempLog, append: () => {}, sensitivePaths: null });
    expect(optOut).toMatchObject({ deterministic: "risky", sensitiveClasses: ["deps"], final: "no_verdict" });
  });

  it("screens against the base ref's list, so a PR that narrows the list cannot lower its own tier", async () => {
    const tempLog = join(mkdtempSync(join(tmpdir(), "jev-log-")), "log.jsonl");
    temps.push(dirname(tempLog));
    const ask = async () => ({ ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 });
    // The PR removes the .env glob and adds a .env file.
    const dir = baseAndHeadRepo(withoutGlob("**/.env*"));
    const pr = { pr: 5, sha: "e", deterministic: "low", files: [".env.production"] };
    const [fromBase] = await fixtureScreen([pr], { ask, root: dir, baseRef: "HEAD^1", log: tempLog, append: () => {} });
    expect(fromBase).toMatchObject({ deterministic: "risky", sensitiveClasses: ["secrets"], sensitivePathsUnavailable: false, final: "risky" });
    // The working tree (the PR's own list) is what --base-ref replaces.
    const [fromHead] = await fixtureScreen([pr], { ask, root: dir, log: tempLog, append: () => {} });
    expect(fromHead).toMatchObject({ deterministic: "low", sensitiveClasses: [], final: "low" });
    // A base ref that cannot be read is never replaced by the head list: "" (an unset $BASE) included.
    for (const baseRef of ["no-such-ref", "", "HEAD~9"]) {
      expect(loadScreenSensitivePaths({ root: dir, baseRef }), JSON.stringify(baseRef)).toBe(SENSITIVE_PATHS_UNAVAILABLE);
      const [record] = await fixtureScreen([pr], { ask, root: dir, baseRef, log: tempLog, append: () => {} });
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
      const [record] = await fixtureScreen([pr], { ask, root: broken, baseRef, log: tempLog, append: () => {} });
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

  it("logs rows with head_sha, cache_hit and tokens, plus the sha and marker_hit aliases", () => {
    const sha = "a".repeat(40);
    const usage = { input_tokens: 412, output_tokens: 9 };
    const result = { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, usage, latencyMs: 250 };
    const miss = decisionRecord({ pr: 100, sha, deterministic: "low" }, result, new Date(0), { ...SKIP, caller: "qa" });
    expect(Object.keys(miss).sort()).toEqual(
      ["caller", "cache_hit", "deterministic", "fallback_reason", "fallback_source", "filesProblem", "final", "head_sha", "jev", "kind", "latency_ms", "marker_hit", "marker_tier", "model", "ok", "pr", "reason", "screener", "sensitiveClasses", "sensitivePathsUnavailable", "sha", "tokens", "ts", "warning"].sort(),
    );
    expect(miss).toMatchObject({ head_sha: sha, sha, cache_hit: false, marker_hit: false, tokens: { input_tokens: 412, output_tokens: 9 }, latency_ms: 250 });

    // A cache hit made no Jev call: no tokens, no latency.
    const hit = decisionRecord({ pr: 100, sha, deterministic: "low" }, result, new Date(0), { ...SKIP, markerHit: true, markerTier: "low" });
    expect(hit).toMatchObject({ head_sha: sha, sha, cache_hit: true, marker_hit: true, tokens: null, latency_ms: null });

    // No usage, unusable counts or a failed call: null, never invented numbers.
    const tokensOf = (extra) => decisionRecord({ pr: 100, sha, deterministic: "low" }, { ...result, ...extra }, new Date(0), SKIP).tokens;
    expect(tokensOf({ usage: undefined })).toBeNull();
    expect(tokensOf({ usage: null })).toBeNull();
    expect(tokensOf({ usage: { input_tokens: "12", output_tokens: -1 } })).toBeNull();
    expect(tokensOf({ usage: { input_tokens: 7 } })).toEqual({ input_tokens: 7, output_tokens: null });
    expect(decisionRecord({ pr: 100, sha, deterministic: "low" }, { ok: false, reason: "timeout", usage }, new Date(0), SKIP).tokens).toBeNull();

    // replay() reads either name for the cache hit flag and the SHA.
    const row = { pr: 1, ok: true, deterministic: "low", final: "risky", marker_tier: "risky", jev: { tier: "low", confidence: 0.99 } };
    expect(replay([{ ...row, head_sha: "c", cache_hit: true }])).toEqual([{ pr: 1, sha: "c", before: "risky", after: "risky", changed: false }]);
    expect(replay([{ ...row, sha: "c", marker_hit: true }])).toEqual([{ pr: 1, sha: "c", before: "risky", after: "risky", changed: false }]);
  });

  it("logs Jev's token usage from screen() and null on a cache hit", async () => {
    const github = fakeGitHub({ heads: { 846: SHA } });
    const ask = async () => ({ ok: true, model: JEV_MODEL, answers: { tier: { type: "choice", choice: "normal", confidence: 0.9 }, incident: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 300, output_tokens: 4 }, latencyMs: 50 });
    const [first] = await fixtureScreen([readme()], { ...quiet, ask, marker: github.io });
    const [second] = await fixtureScreen([readme()], { ...quiet, ask, marker: github.io });
    expect(first).toMatchObject({ cache_hit: false, tokens: { input_tokens: 300, output_tokens: 4 } });
    expect(second).toMatchObject({ cache_hit: true, tokens: null });
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

  it("warns on stderr when the decision log cannot be written, and still completes the screen", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failingAppend = () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      };
      const records = await fixtureScreen([{ pr: 3, sha: "c", deterministic: "low", title: "secret title", files: ["README.md"] }], { ask: askLow, log: "/dev/null", append: failingAppend, warn: undefined });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ pr: 3, ok: true, final: "low" });
      const logLines = stderr.mock.calls.map((args) => args.join(" ")).filter((line) => line.includes("decision log"));
      expect(logLines).toEqual(["jev-pr-screen: decision log write failed (ENOSPC); the screen result stands"]);
      expect(logLines[0]).not.toContain("pr_risk_screen");

      // No code: the sanitized message, as one line.
      stderr.mockClear();
      const plain = () => {
        throw new Error("disk\nfull");
      };
      const [record] = await fixtureScreen([{ pr: 4, sha: "d", deterministic: "low", files: ["README.md"] }], { ask: askLow, log: "/dev/null", append: plain, warn: undefined });
      expect(record.final).toBe("low");
      const messageLines = stderr.mock.calls.map((args) => args.join(" ")).filter((line) => line.includes("decision log"));
      expect(messageLines).toEqual(["jev-pr-screen: decision log write failed (disk_full); the screen result stands"]);
    } finally {
      stderr.mockRestore();
    }
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
/** The base commit every synthetic acquisition reports (the real transport reads it from the PR). */
const BASE = OTHER_SHA;
/** A synthetic acquisition: paths plus the verified head/base snapshot the real transport returns. */
function acq(paths, base = BASE) {
  return { paths, snapshot: { head: SHA, base, count: paths.length }, revalidate: () => {} };
}
/** The state Jev is sent for readme() with the default quiet acquisition. */
function defaultState(overrides = {}) {
  return { title: "Docs", files: ["README.md"], additions: null, deletions: null, notes: "", ...overrides };
}
const Q = hashQuestions(SCREEN_QUESTIONS);
const F = hashScreenState(defaultState(), OTHER_SHA);
const markerText = (fields = {}) =>
  buildMarkerDescription({ tier: "normal", jevTier: "normal", confidence: 0.9, pIncident: 0.1, model: JEV_MODEL, questionHash: Q, stateHash: F, ...fields });
const status = (description, { context = MARKER_CONTEXT, state = "success", login = "optomachina" } = {}) => ({ context, state, description, creator: { login } });
const STATUSES_PATH = /^repos\/optomachina\/Overdrafter\/commits\/([0-9a-f]{40})\/statuses\?per_page=100&page=([1-9]\d*)$/;
const statusesPage = (sha, page) => ["api", `repos/optomachina/Overdrafter/commits/${sha}/statuses?per_page=100&page=${page}`];
/** n statuses from other tools (never markers), to push markers onto later pages. */
const filler = (n) => Array.from({ length: n }, (_, k) => status(`check ${k}`, { context: `ci/${k}` }));
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
    if (read) {
      // GitHub pages: per_page=100, page is 1-based.
      const start = (Number(read[2]) - 1) * 100;
      return JSON.stringify((store[read[1]] ?? []).slice(start, start + 100));
    }
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
    read: (sha, model, questionHash, stateHash) => readMarker(sha, model, questionHash, stateHash, { run }),
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

const quiet = { files: () => acq(["README.md"]), log: "/dev/null", append: () => {}, warn: () => {} };
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
    expect(text).toBe(`v3 tier=risky jev=normal c=0.876 p=0.124 model=jev-1.13.0 q=abc12345 screener=mjs s=${F}`);
    expect(text.length).toBeLessThanOrEqual(140);
    expect(parseMarkerDescription(text)).toEqual({ version: "v3", tier: "risky", jevTier: "normal", confidence: 0.876, pIncident: 0.124, model: "jev-1.13.0", questionHash: "abc12345", screener: "mjs", stateHash: F });
    expect(parseMarkerDescription(markerText({ pIncident: null })).pIncident).toBeNull();
    expect(parseMarkerDescription(markerText({ confidence: 1, pIncident: 0 }))).toMatchObject({ confidence: 1, pIncident: 0 });
    for (const bad of ["v3 tier=low jev=low c=0.9 p=na model=m q=abc12345 screener=mjs", "v1 tier=low", "v1 tier=Low jev=low c=0.9 p=na model=m q=abc12345 screener=mjs", "v1 tier=low jev=low c=1.5 p=na model=m q=abc12345 screener=mjs", "v1 tier=low jev=low p=na model=m q=abc12345 screener=mjs", "", null]) {
      expect(parseMarkerDescription(bad), String(bad)).toBeNull();
    }
  });

  it("rejects a marker with a duplicate field, so an appended tier cannot lower a risky marker", () => {
    const risky = markerText({ tier: "risky" });
    const duplicates = [
      `${risky} tier=low jev=low`, // the Architect's repro: the last duplicate used to win
      `${risky} tier=risky`, // repeated with the same value is still rejected
      `${risky} c=0.9`,
      `${risky} p=na`,
      `${risky} model=${JEV_MODEL}`,
      `${risky} q=${Q}`,
      `${risky} screener=mjs`,
      risky.replace("jev=normal", "jev=normal jev=low"),
    ];
    for (const text of duplicates) expect(parseMarkerDescription(text), text).toBeNull();
  });

  const CONTRADICTIONS = [["low", "normal"], ["low", "risky"], ["normal", "risky"]];

  it("rejects a contradictory marker whose final tier is below its Jev tier, on read and on write", async () => {
    for (const [tier, jevTier] of CONTRADICTIONS) {
      const text = markerText({ tier, jevTier, confidence: 0.99 });
      expect(parseMarkerDescription(text), text).toBeNull();
      const github = fakeGitHub();
      const marker = { tier, jevTier, confidence: 0.99, pIncident: 0, model: JEV_MODEL, questionHash: Q, stateHash: F };
      expect(await writeMarker(SHA, marker, { run: github.run }), `${tier}/${jevTier}`).toEqual({ success: false, reason: "invalid_tier" });
      expect(github.calls, `${tier}/${jevTier}`).toEqual([]);
    }
    // Equal and higher final tiers stay valid, on parse and on write.
    for (const [tier, jevTier] of [["low", "low"], ["normal", "normal"], ["risky", "risky"], ["normal", "low"], ["risky", "low"], ["risky", "normal"]]) {
      expect(parseMarkerDescription(markerText({ tier, jevTier })), `${tier}/${jevTier}`).toMatchObject({ tier, jevTier });
      const github = fakeGitHub();
      expect(await writeMarker(SHA, { tier, jevTier, confidence: 0.9, model: JEV_MODEL, questionHash: Q, stateHash: F }, { run: github.run })).toEqual({ success: true });
    }
  });

  it("misses the whole read when a trusted marker is contradictory, in either order, and screen() runs fresh", async () => {
    const sound = status(markerText({ tier: "low", jevTier: "low", confidence: 0.99 }));
    for (const [tier, jevTier] of CONTRADICTIONS) {
      const contradictory = status(markerText({ tier, jevTier, confidence: 0.99 }));
      const sound2 = status(markerText({ tier, jevTier: tier, confidence: 0.99 }));
      for (const [name, statuses] of [["contradictory newest", [contradictory, sound2]], ["contradictory oldest", [sound2, contradictory]]]) {
        const label = `${tier}/${jevTier} ${name}`;
        const read = fakeGitHub({ statuses: { [SHA]: statuses } });
        expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: read.run }), label).toEqual({ found: false, reason: "rejected_marker" });
        // A fresh risky answer is the result; the cache never decides, so nothing lowers it.
        const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: statuses } });
        const jev = countingJev("risky", 0.99, 0);
        const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
        expect(jev.calls, label).toBe(1);
        expect(record, label).toMatchObject({ cache_hit: false, marker_hit: false, final: "risky" });
      }
    }
    // The Architect's reproducer: [tier=low jev=low, tier=low jev=risky], newest first, both c=0.99.
    for (const statuses of [[sound, status(markerText({ tier: "low", jevTier: "risky", confidence: 0.99 }))], [status(markerText({ tier: "low", jevTier: "risky", confidence: 0.99 })), sound]]) {
      const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: statuses } });
      const jev = countingJev("risky", 0.99, 0);
      const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
      expect(jev.calls).toBe(1);
      expect(record).toMatchObject({ cache_hit: false, final: "risky" });
    }
  });

  it("rejects malformed fields: hash format, confidence, incident, tier, version and extra junk", () => {
    const base = markerText();
    const swap = (from, to) => base.replace(from, to);
    const malformed = {
      hash: [swap(`q=${Q}`, "q=ABC12345"), swap(`q=${Q}`, "q=abc1234"), swap(`q=${Q}`, "q=abc123456"), swap(`q=${Q}`, "q=xyz12345"), swap(`q=${Q}`, "q=")],
      confidence: [swap("c=0.9", "c=abc"), swap("c=0.9", "c=NaN"), swap("c=0.9", "c=-0.1"), swap("c=0.9", "c=1.5"), swap("c=0.9", "c=1.001"), swap("c=0.9", "c=0.9999"), swap("c=0.9", "c=1e-1"), swap("c=0.9", "c=.9"), swap("c=0.9", "c=0x1"), swap("c=0.9", "c=Infinity")],
      incident: [swap("p=0.1", "p=abc"), swap("p=0.1", "p=2"), swap("p=0.1", "p=-0"), swap("p=0.1", "p=NA"), swap("p=0.1", "p=null")],
      tier: [swap("tier=normal", "tier=high"), swap("tier=normal", "tier=Normal"), swap("jev=normal", "jev=critical"), swap("tier=normal", "tier=")],
      version: [swap("v3 ", "v1.0 "), swap("v3 ", "V1 "), swap("v3 ", "")],
      junk: [`${base} junk`, `${base} x=1`, `${base} a=b=c`, swap("tier=normal", "tier==normal"), swap("model=", "Model="), `${base} =`, swap(" c=0.9", " c=0.9;"), `${base} ${"x".repeat(140)}`],
      missing: [swap(" p=0.1", ""), swap(" screener=mjs", ""), swap(` q=${Q}`, "")],
    };
    for (const [kind, texts] of Object.entries(malformed)) {
      for (const text of texts) expect(parseMarkerDescription(text), `${kind}: ${text}`).toBeNull();
    }
  });

  it("treats a rejected marker as a miss, never as a hit", async () => {
    const risky = markerText({ tier: "risky" });
    const rejected = [`${risky} tier=low jev=low`, risky.replace(`q=${Q}`, "q=ABC12345"), risky.replace("c=0.9", "c=9"), risky.replace("tier=risky", "tier=extreme"), `${risky} junk`];
    for (const description of rejected) {
      const github = fakeGitHub({ statuses: { [SHA]: [status(description)] } });
      expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: github.run }), description).toEqual({ found: false, reason: "rejected_marker" });
    }
    // Through screen(): the tampered marker is a miss, so Jev runs and its answer stands.
    const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [status(`${risky} tier=low jev=low`)] } });
    const jev = countingJev("normal");
    const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(1);
    expect(record).toMatchObject({ cache_hit: false, final: "normal" });
  });

  it("rejects a bad SHA and a status that names another commit", async () => {
    const github = fakeGitHub({ statuses: { [SHA]: [status(markerText())] } });
    for (const sha of [SHA.slice(0, 39), `${SHA}0`, `${SHA.slice(0, 39)}g`, ` ${SHA}`, `${SHA}\n`, `${SHA}/statuses`, "", null, 123]) {
      expect(await readMarker(sha, JEV_MODEL, Q, F, { run: github.run }), String(sha)).toEqual({ found: false, reason: "invalid_sha" });
    }
    expect(github.calls).toEqual([]);
    const url = (sha) => `https://api.github.com/repos/optomachina/Overdrafter/statuses/${sha}`;
    const elsewhere = fakeGitHub({ statuses: { [SHA]: [{ ...status(markerText({ tier: "low", jevTier: "low" })), url: url(OTHER_SHA) }, { ...status(markerText()), url: 42 }] } });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: elsewhere.run })).toEqual({ found: false, reason: "rejected_marker" });
    const here = fakeGitHub({ statuses: { [SHA]: [{ ...status(markerText()), url: url(SHA.toUpperCase()) }] } });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: here.run })).toMatchObject({ found: true, tier: "normal" });
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
          status(markerText({ tier: "risky" }), { state: "pending", login: "mallory" }),
          status(markerText({ tier: "risky" }), { context: "jev-screen/other" }),
          status(markerText({ tier: "risky", model: "jev-1.12.0" })),
          status(markerText({ tier: "risky", questionHash: "deadbeef" })),
          status(markerText({ tier: "risky" }).replace("screener=mjs", "screener=py")),
          status("v1 tier=risky garbage", { login: "mallory" }),
          status(markerText({ tier: "low", jevTier: "low" })),
        ],
      },
    });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: github.run })).toEqual({ found: true, version: "v3", tier: "low", jevTier: "low", confidence: 0.9, pIncident: 0.1, model: JEV_MODEL, questionHash: Q, screener: "mjs", stateHash: F });
    // Reads the raw JSON (no --jq filter, which made gh exit 1 on the array).
    expect(github.calls).toEqual([statusesPage(SHA, 1)]);
  });

  it("takes the highest tier when several markers match, then the newest", async () => {
    const github = fakeGitHub({ statuses: { [SHA]: [status(markerText({ tier: "normal" })), status(markerText({ tier: "risky" })), status(markerText({ tier: "low", jevTier: "low" }))] } });
    expect((await readMarker(SHA, JEV_MODEL, Q, F, { run: github.run })).tier).toBe("risky");
    // Statuses are newest first: on a tier tie the newest marker wins.
    const tie = fakeGitHub({ statuses: { [SHA]: [status(markerText({ tier: "risky", jevTier: "low", confidence: 0.7 })), status(markerText({ tier: "risky", jevTier: "risky", confidence: 0.95 }))] } });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: tie.run })).toMatchObject({ tier: "risky", jevTier: "low", confidence: 0.7 });
  });

  it("reads every page of statuses, so a stronger marker past the first 100 is never missed", async () => {
    // The Architect's repro: a low marker on page 1 and a risky marker on page 2 used to give a low hit.
    const low = status(markerText({ tier: "low", jevTier: "low" }));
    const risky = status(markerText({ tier: "risky" }));
    const pageTwo = fakeGitHub({ statuses: { [SHA]: [low, ...filler(99), risky, ...filler(5)] } });
    expect((await readMarker(SHA, JEV_MODEL, Q, F, { run: pageTwo.run })).tier).toBe("risky");
    // Page 1 is read again after the last page to catch a status added while paging.
    expect(pageTwo.calls).toEqual([statusesPage(SHA, 1), statusesPage(SHA, 2), statusesPage(SHA, 1)]);
    // 250 statuses: the strongest marker is on page 3 of 3.
    const pageThree = fakeGitHub({ statuses: { [SHA]: [low, ...filler(220), risky, ...filler(28)] } });
    expect(pageThree.store[SHA]).toHaveLength(250);
    expect((await readMarker(SHA, JEV_MODEL, Q, F, { run: pageThree.run })).tier).toBe("risky");
    expect(pageThree.calls).toEqual([1, 2, 3, 1].map((page) => statusesPage(SHA, page)));
    // Exactly 100 statuses: a full page is never taken as the end, so page 2 (empty) is read too.
    const full = fakeGitHub({ statuses: { [SHA]: [low, ...filler(99)] } });
    expect((await readMarker(SHA, JEV_MODEL, Q, F, { run: full.run })).tier).toBe("low");
    expect(full.calls).toEqual([statusesPage(SHA, 1), statusesPage(SHA, 2), statusesPage(SHA, 1)]);
    // The only marker sits on page 2.
    const onlyLater = fakeGitHub({ statuses: { [SHA]: [...filler(150), low] } });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: onlyLater.run })).toMatchObject({ found: true, tier: "low" });
  });

  it("misses fail-safe when a later page fails, a page is oversized or the pages never end", async () => {
    const low = status(markerText({ tier: "low", jevTier: "low" }));
    const firstPageThenFail = (args) => {
      if (args[1].endsWith("&page=1")) return JSON.stringify([low, ...filler(99)]);
      throw new Error("gh: HTTP 502");
    };
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: firstPageThenFail })).toMatchObject({ found: false, reason: "api_error", error: "gh: HTTP 502" });
    const badSecondPage = (args) => (args[1].endsWith("&page=1") ? JSON.stringify([low, ...filler(99)]) : "{}");
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: badSecondPage })).toMatchObject({ found: false, reason: "api_error" });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: () => JSON.stringify([low, ...filler(100)]) })).toMatchObject({ found: false, reason: "api_error" });
    let pages = 0;
    const endless = () => {
      pages += 1;
      return JSON.stringify([low, ...filler(99)]);
    };
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: endless })).toMatchObject({ found: false, reason: "api_error", error: `more than ${MAX_STATUS_PAGES} pages of statuses` });
    expect(pages).toBe(MAX_STATUS_PAGES);
  });

  it("misses when any trusted marker on any tier is rejected, so a lower valid marker never wins", async () => {
    const url = (sha) => `https://api.github.com/repos/optomachina/Overdrafter/statuses/${sha}`;
    const validLow = status(markerText({ tier: "low", jevTier: "low" }));
    const validRisky = status(markerText({ tier: "risky" }));
    const risky = markerText({ tier: "risky" });
    const low = markerText({ tier: "low", jevTier: "low" });
    const rejected = {
      "malformed risky": [status(`${risky} tier=low`), validLow],
      "risky naming another commit": [{ ...status(risky), url: url(OTHER_SHA) }, validLow],
      "risky in failure state": [status(risky, { state: "failure" }), validLow],
      "risky in error state": [status(risky, { state: "error" }), validLow],
      "risky still pending": [status(risky, { state: "pending" }), validLow],
      "unparseable, below the valid marker": [validLow, status("v1 tier=risky garbage")],
      "malformed low next to a valid risky": [status(`${low} junk`), validRisky],
      "low naming another commit, on page 2": [validRisky, ...filler(120), { ...status(low), url: url(OTHER_SHA) }],
    };
    for (const [name, statuses] of Object.entries(rejected)) {
      const github = fakeGitHub({ statuses: { [SHA]: statuses } });
      expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: github.run }), name).toEqual({ found: false, reason: "rejected_marker" });
    }
    // Through screen(): a rejected risky marker next to a valid low one is a miss, so Jev runs again.
    const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: rejected["risky in failure state"] } });
    const jev = countingJev("normal");
    const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(1);
    expect(record).toMatchObject({ cache_hit: false, final: "normal" });
    // Not rejections: an untrusted author's status, and a well-formed trusted marker for another key.
    const otherKeys = fakeGitHub({ statuses: { [SHA]: [status(risky, { state: "failure", login: "mallory" }), status(markerText({ tier: "risky", model: "jev-1.12.0" })), validLow] } });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: otherKeys.run })).toMatchObject({ found: true, tier: "low" });
  });

  it("misses when page 1 changes while paging, so a newly added marker is never hidden", async () => {
    const low = status(markerText({ tier: "low", jevTier: "low" }));
    const risky = status(markerText({ tier: "risky" }));
    // A risky marker is posted after page 1 is read: every later page shifts by one and the risky marker is never on them.
    const github = fakeGitHub({ statuses: { [SHA]: [low, ...filler(150)] } });
    const run = (args) => {
      if (args[1].endsWith("&page=2") && github.store[SHA][0] !== risky) github.store[SHA].unshift(risky);
      return github.run(args);
    };
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run })).toMatchObject({ found: false, reason: "statuses_changed" });
    expect(github.calls).toEqual([statusesPage(SHA, 1), statusesPage(SHA, 2), statusesPage(SHA, 1)]);
    // Any change counts, even a status that is not a marker.
    const other = fakeGitHub({ statuses: { [SHA]: [low, ...filler(150)] } });
    const runOther = (args) => {
      if (args[1].endsWith("&page=3")) other.store[SHA].unshift(status("new check", { context: "ci/new" }));
      return other.run(args);
    };
    other.store[SHA].push(...filler(60));
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: runOther })).toMatchObject({ found: false, reason: "statuses_changed" });
    // Through screen(): the shifted read is a miss, so Jev runs and the result is not the stale low marker.
    const shifted = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [low, ...filler(150)] } });
    const io = {
      ...shifted.io,
      read: (sha, model, questionHash, stateHash) =>
        readMarker(sha, model, questionHash, stateHash, {
          run: (args) => {
            if (args[1].endsWith("&page=2") && shifted.store[SHA][0] !== risky) shifted.store[SHA].unshift(risky);
            return shifted.run(args);
          },
        }),
    };
    const jev = countingJev("normal");
    const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: io });
    expect(jev.calls).toBe(1);
    expect(record).toMatchObject({ cache_hit: false, final: "normal" });
  });

  it("screens risky when the risky marker is on page 2 (no fail-open through a truncated list)", async () => {
    const statuses = [status(markerText({ tier: "low", jevTier: "low", confidence: 0.99 })), ...filler(120), status(markerText({ tier: "risky", jevTier: "low", confidence: 0.99 }))];
    const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: statuses } });
    const jev = countingJev("low", 0.99);
    const [record] = await screen([readme()], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(0);
    expect(record).toMatchObject({ cache_hit: true, marker_tier: "risky", final: "risky" });
  });

  it("misses fail-safe on no marker, an invalid SHA, an API error or a bad response", async () => {
    const github = fakeGitHub({ statuses: { [SHA]: [status("all good", { context: "CodeRabbit" })] } });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: github.run })).toEqual({ found: false, reason: "no_marker" });
    expect(await readMarker(OTHER_SHA, JEV_MODEL, Q, F, { run: github.run })).toEqual({ found: false, reason: "no_marker" });
    expect(await readMarker("head", JEV_MODEL, Q, F, { run: github.run })).toEqual({ found: false, reason: "invalid_sha" });
    expect(github.calls).toHaveLength(2);
    const failing = () => {
      throw new Error("gh: HTTP 502");
    };
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: failing })).toMatchObject({ found: false, reason: "api_error", error: "gh: HTTP 502" });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: () => "{}" })).toMatchObject({ found: false, reason: "api_error" });
    expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: () => "not json" })).toMatchObject({ found: false, reason: "api_error" });
  });

  it("writes a success marker and fails open", async () => {
    const github = fakeGitHub();
    const marker = { tier: "risky", jevTier: "normal", confidence: 0.9, pIncident: 0.2, model: JEV_MODEL, questionHash: Q, stateHash: F };
    expect(await writeMarker(SHA, marker, { run: github.run })).toEqual({ success: true });
    expect(github.calls).toEqual([
      ["api", `repos/optomachina/Overdrafter/statuses/${SHA}`, "-X", "POST", "-f", "state=success", "-f", `description=${markerText({ tier: "risky", pIncident: 0.2 })}`, "-f", "context=jev-screen"],
    ]);
    expect((await readMarker(SHA, JEV_MODEL, Q, F, { run: github.run })).tier).toBe("risky");
    expect(await writeMarker("abc123", marker, { run: github.run })).toEqual({ success: false, reason: "invalid_sha" });
    expect(await writeMarker(SHA, { ...marker, tier: "high" }, { run: github.run })).toEqual({ success: false, reason: "invalid_tier" });
    expect(await writeMarker(SHA, { ...marker, confidence: 1.2 }, { run: github.run })).toEqual({ success: false, reason: "invalid_probability" });
    expect(await writeMarker(SHA, { ...marker, model: "bad model" }, { run: github.run })).toEqual({ success: false, reason: "invalid_key" });
    expect(await writeMarker(SHA, { ...marker, questionHash: "not-a-hash" }, { run: github.run })).toEqual({ success: false, reason: "invalid_key" });
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

  it("screens again and writes a new marker when the PR head moves to a new SHA", async () => {
    // A marker already exists for the old head SHA; the PR head then moves to NEW_SHA.
    const NEW_SHA = "1111111111111111111111111111111111111111";
    const github = fakeGitHub({ heads: { 846: NEW_SHA }, statuses: { [SHA]: [status(markerText({ tier: "low", jevTier: "low", confidence: 0.99 }))] } });
    const jev = countingJev("normal", 0.9, 0.2);
    const [record] = await screen([readme(846, NEW_SHA)], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(1);
    expect(record).toMatchObject({ head_sha: NEW_SHA, cache_hit: false, marker_hit: false, final: "normal" });
    // Exactly one new marker, on the new SHA; the old SHA's marker is untouched.
    expect(github.posts().map((args) => args[1])).toEqual([`repos/optomachina/Overdrafter/statuses/${NEW_SHA}`]);
    expect(parseMarkerDescription(github.store[NEW_SHA][0].description)).toMatchObject({ tier: "normal", jevTier: "normal", model: JEV_MODEL, questionHash: Q });
    expect(github.store[SHA]).toHaveLength(1);
    // The next screen at the new head is a cache hit; the old SHA is no longer the head, so it is never read.
    const [again] = await screen([readme(846, NEW_SHA)], { ...quiet, ask: jev.ask, marker: github.io });
    expect(jev.calls).toBe(1);
    expect(again).toMatchObject({ head_sha: NEW_SHA, cache_hit: true, final: "normal" });
    expect(github.calls.some((args) => args[1].includes(SHA))).toBe(false);
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
    const [migration] = await screen([{ ...readme(), files: [MIGRATION_SQL] }], { ...quiet, ask: jev.ask, marker: lowMarker.io, files: () => acq([MIGRATION_SQL]) });
    expect(migration).toMatchObject({ marker_hit: false, deterministic: "risky", final: "risky" });
    // A stored confidence below the current floor is uncertain, so at least normal.
    const [stricter] = await screen([readme()], { ...quiet, ask: jev.ask, marker: lowMarker.io, minConfidence: 0.995 });
    expect(stricter).toMatchObject({ marker_hit: true, final: "no_verdict" });
    expect(stricter.jev.status).toBe("uncertain");
    // A hit with a tier the reader does not know counts as risky.
    const odd = { read: async () => ({ found: true, tier: "unknown", jevTier: "low", confidence: 0.99, pIncident: null, model: JEV_MODEL }), write: async () => ({ success: true }), headSha: async () => SHA };
    const [unknown] = await screen([readme()], { ...quiet, ask: jev.ask, marker: odd });
    expect(unknown).toMatchObject({ marker_hit: true, marker_tier: "risky", final: "risky" });
    expect(jev.calls).toBe(1);
  });

  it("writes markers only for accepted answers, and a failed write keeps the result", async () => {
    const github = fakeGitHub({ heads: { 846: SHA } });
    const [uncertain] = await screen([readme()], { ...quiet, ask: countingJev("low", 0.4).ask, marker: github.io });
    expect(uncertain).toMatchObject({ final: "no_verdict", marker_hit: false });
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
    expect(record).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE });
    expect(jev.calls).toBe(0);
    expect(stale.calls.map((args) => args[1])).toEqual(["repos/optomachina/Overdrafter/pulls/846"]);
    expect(warnings.join("\n")).toMatch(/is not the PR head/);

    const unknownHead = fakeGitHub({ statuses: marked });
    await screen([readme()], { ...quiet, ask: jev.ask, marker: unknownHead.io });
    expect(unknownHead.posts()).toHaveLength(0);
    expect(jev.calls).toBe(0);

    // No PR number or a short SHA: no GitHub call at all.
    const none = fakeGitHub({ heads: { 846: SHA }, statuses: marked });
    await screen([readme(0), readme(-1), readme(846, "abc123"), { ...readme(), pr: undefined }], { ...quiet, ask: jev.ask, marker: none.io });
    expect(none.calls).toEqual([]);
    expect(jev.calls).toBe(0);
  });

  it("treats a throwing marker reader or head lookup as a miss", async () => {
    const boom = async () => {
      throw new Error("boom");
    };
    const jev = countingJev("normal");
    const [readFails] = await screen([readme()], { ...quiet, ask: jev.ask, marker: { read: boom, write: async () => ({ success: true }), headSha: async () => SHA } });
    const [headFails] = await screen([readme()], { ...quiet, ask: jev.ask, marker: { read: boom, write: boom, headSha: boom } });
    expect([readFails.marker_hit, headFails.marker_hit, jev.calls]).toEqual([false, false, 1]);
  });
});

/** Complete fake REST transport, including independently supplied metadata. */
function fileTransport({ paths = ["README.md"], count = paths.length, pageError = 0, malformed = false, race = false, head = SHA, baseRace = false } = {}) {
  const calls = [];
  let snapshots = 0;
  const run = (args) => {
    calls.push(args);
    const page = /\/files\?per_page=100&page=(\d+)$/.exec(args[1]);
    if (page) {
      const n = Number(page[1]);
      if (n === pageError) throw new Error("HTTP 502");
      if (malformed) return '{"message":"bad"}';
      return JSON.stringify(paths.slice((n - 1) * 100, n * 100).map((filename) => ({ filename, status: "modified" })));
    }
    snapshots += 1;
    return JSON.stringify({ head: { sha: race && snapshots > 1 ? OTHER_SHA : head }, base: { sha: baseRace && snapshots > 1 ? SHA : OTHER_SHA }, changed_files: count });
  };
  return { calls, files: (pr, sha) => verifiedPrFiles(pr, sha, { run }) };
}

describe("OVD-961 authoritative file boundaries", () => {
  it("acquires page two and ignores a truncated caller list before cache/classification", async () => {
    const paths = [...Array.from({ length: 100 }, (_, i) => `docs/${i}.md`), MIGRATION_SQL];
    const transport = fileTransport({ paths });
    const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [status(markerText({ tier: "low", jevTier: "low" }))] } });
    const ask = vi.fn(countingJev("low").ask);
    const [record] = await screen([readme()], { ...quiet, files: transport.files, marker: github.io, ask });
    expect(record).toMatchObject({ final: "risky", deterministic: "risky", cache_hit: false, filesProblem: null });
    expect(ask.mock.calls[0][0].files).toEqual(paths);
    expect(transport.calls.filter((args) => args[1].includes("/files?"))).toHaveLength(2);
    expect(parseMarkerDescription(github.store[SHA][0].description).stateHash).toBe(hashScreenState(ask.mock.calls[0][0], BASE));
  });

  it.each([
    ["count mismatch", { count: 2 }],
    ["failed second page", { paths: Array.from({ length: 101 }, (_, i) => `docs/${i}`), pageError: 2 }],
    ["malformed page", { malformed: true }],
    ["invalid path", { paths: [null] }],
    ["duplicate page", { paths: Array.from({ length: 101 }, () => "README.md") }],
    ["exactly 3000 cap", { paths: Array.from({ length: 3000 }, (_, i) => `docs/${i}`) }],
    ["underreported cap", { paths: Array.from({ length: 3000 }, (_, i) => `docs/${i}`), count: 2999 }],
    ["head race", { race: true }],
    ["base race", { baseRace: true }],
    ["wrong requested head", { head: OTHER_SHA }],
    ["malformed count", { count: "1" }],
  ])("gives no verdict without cache or model calls: %s", async (_name, config) => {
    const transport = fileTransport(config);
    const marker = { read: vi.fn(), write: vi.fn(), headSha: vi.fn() };
    const ask = vi.fn();
    const [record] = await screen([readme()], { ...quiet, files: transport.files, marker, ask });
    expect(record).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE, cache_hit: false });
    expect(ask).not.toHaveBeenCalled();
    for (const fn of Object.values(marker)) expect(fn).not.toHaveBeenCalled();
  });

  it("checks the final page for exact multiples and rejects malformed JSON", () => {
    const paths = Array.from({ length: 100 }, (_, i) => `docs/${i}`);
    const transport = fileTransport({ paths });
    expect(transport.files(846, SHA).paths).toEqual(paths);
    expect(transport.calls.filter((args) => args[1].includes("/files?"))).toHaveLength(2);
    expect(() => verifiedPrFiles(846, SHA, { run: () => "invalid" })).toThrow();
  });

  it("detects a head move during Jev before writing a marker", async () => {
    const github = fakeGitHub({ heads: { 846: SHA } });
    let calls = 0;
    github.io.headSha = async () => ++calls === 1 ? SHA : OTHER_SHA;
    const [record] = await screen([readme()], { ...quiet, files: fileTransport().files, marker: github.io, ask: countingJev("low").ask });
    expect(record).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE });
    expect(github.posts()).toHaveLength(0);
  });

  it("pre-PR derives a local diff, ignores supplied files, and performs zero cache operations", async () => {
    const root = baseAndHeadRepo(withoutGlob("**/.env*"));
    const marker = { read: vi.fn(), write: vi.fn(), headSha: vi.fn() };
    const files = vi.fn();
    const ask = vi.fn(countingJev("low").ask);
    const [record] = await screen([{ ...readme(), pr: undefined }], { ...quiet, root, baseRef: "HEAD^", marker, files, ask });
    expect(record).toMatchObject({ final: "risky", filesProblem: null, cache_hit: false });
    expect(ask.mock.calls[0][0].files).toEqual([SENSITIVE_PATHS_FILE]);
    for (const fn of [...Object.values(marker), files]) expect(fn).not.toHaveBeenCalled();
    for (const baseRef of [null, "", "no-such-ref", "--help"]) {
      const [failed] = await screen([{ ...readme(), pr: undefined }], { ...quiet, root, baseRef, marker, files, ask });
      expect(failed).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE });
    }
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

/** Mutable REST snapshot for rename and post-acquisition identity regressions. */
function mutableAcquisition(records) {
  const fixture = { snapshot: { head: { sha: SHA }, base: { sha: OTHER_SHA }, changed_files: records.length } };
  fixture.files = (pr, sha) => verifiedPrFiles(pr, sha, { run: (args) => {
    if (args[1].includes("/files?")) return JSON.stringify(records);
    if (fixture.snapshot === null) throw new Error("snapshot unavailable");
    return JSON.stringify(fixture.snapshot);
  } });
  return fixture;
}

describe("OVD-961 independent review regressions", () => {
  const renamed = { filename: "docs/plain.md", previous_filename: ".github/workflows/required.yml", status: "renamed" };

  it("preserves sensitive rename sources, reconciles records and hashes the complete affected set", async () => {
    const acquisition = mutableAcquisition([renamed]);
    const github = fakeGitHub({ heads: { 846: SHA } });
    const ask = vi.fn(countingJev("low").ask);
    const [record] = await screen([readme()], { ...quiet, files: acquisition.files, marker: github.io, ask });
    const paths = [renamed.filename, renamed.previous_filename];
    expect(record).toMatchObject({ final: "risky", deterministic: "risky", filesProblem: null });
    expect(ask.mock.calls[0][0].files).toEqual(paths);
    expect(parseMarkerDescription(github.store[SHA][0].description)).toMatchObject({ tier: "risky", stateHash: hashScreenState(ask.mock.calls[0][0], BASE) });
    expect(acquisition.files(846, SHA).snapshot.count).toBe(1);
    const chain = mutableAcquisition([renamed, { filename: "docs/next.md", previous_filename: renamed.filename, status: "renamed" }]);
    expect(chain.files(846, SHA).paths).toEqual([...paths, "docs/next.md"]);
  });

  it.each([
    { filename: "docs/plain.md", status: "renamed" },
    { ...renamed, previous_filename: "" },
    { ...renamed, previous_filename: null },
    { ...renamed, previous_filename: 123 },
    { ...renamed, previous_filename: "bad\0path" },
    { ...renamed, previous_filename: renamed.filename },
    { ...renamed, status: "modified" },
  ])("rejects malformed rename metadata before cache or model access: %j", async (entry) => {
    const marker = { headSha: vi.fn(), read: vi.fn(), write: vi.fn() };
    const ask = vi.fn();
    const [record] = await screen([readme()], { ...quiet, files: mutableAcquisition([entry]).files, marker, ask });
    expect(record).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE });
    for (const fn of [...Object.values(marker), ask]) expect(fn).not.toHaveBeenCalled();
  });

  it("preserves both sides of a real local rename even when git recognizes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "jev-rename-"));
    temps.push(root);
    const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, renamed.previous_filename), "name: required\non: push\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("mv", renamed.previous_filename, renamed.filename);
    git("commit", "-qm", "rename");
    expect(git("diff", "--name-status", "-M", "HEAD^...HEAD")).toContain("R100");
    expect(new Set(localDiffFiles(root, "HEAD^"))).toEqual(new Set([renamed.filename, renamed.previous_filename]));
    const ask = vi.fn(countingJev("low").ask);
    const marker = { read: vi.fn(), write: vi.fn(), headSha: vi.fn() };
    const [record] = await screen([{ ...readme(), pr: undefined }], { ...quiet, root, baseRef: "HEAD^", sensitivePaths: loadSensitivePaths({ root: repoRoot }), marker, ask });
    expect(record).toMatchObject({ final: "risky", filesProblem: null });
    expect(new Set(ask.mock.calls[0][0].files)).toEqual(new Set([renamed.filename, renamed.previous_filename]));
    for (const fn of Object.values(marker)) expect(fn).not.toHaveBeenCalled();
  });

  function changedRepo() {
    const root = mkdtempSync(join(tmpdir(), "jev-trusted-git-"));
    temps.push(root);
    const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "base");
    writeFileSync(join(root, "a.txt"), "two\n");
    git("commit", "-qam", "change");
    return root;
  }

  it("never executes a git planted first on PATH", () => {
    const root = changedRepo();
    const plant = mkdtempSync(join(tmpdir(), "jev-plant-"));
    temps.push(plant);
    const marker = join(plant, "executed");
    writeFileSync(join(plant, "git"), `#!/bin/sh\necho planted > '${marker}'\nexit 1\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${plant}:${originalPath}`;
    try {
      expect(localDiffFiles(root, "HEAD^")).toEqual(["a.txt"]);
    } finally {
      process.env.PATH = originalPath;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed when no trusted git exists", () => {
    const root = changedRepo();
    const empty = mkdtempSync(join(tmpdir(), "jev-nogit-"));
    temps.push(empty);
    expect(localDiffFiles(root, "HEAD^")).toEqual(["a.txt"]);
    expect(() => localDiffFiles(root, "HEAD^", { dirs: [empty] })).toThrow(FILES_INCOMPLETE);
  });

  it.each(["fresh", "cached"].flatMap((mode) => ["base", "head", "count", "error"].map((change) => [mode, change])))
  ("rejects %s result after post-acquisition %s change without a marker write", async (mode, change) => {
    const acquisition = mutableAcquisition([{ filename: "README.md", status: "modified" }]);
    const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: mode === "cached" ? [status(markerText({ tier: "low", jevTier: "low" }))] : [] } });
    const mutate = () => {
      if (change === "error") acquisition.snapshot = null;
      else if (change === "count") acquisition.snapshot.changed_files = 2;
      else acquisition.snapshot[change].sha = "c".repeat(40);
    };
    const read = github.io.read;
    github.io.read = async (...args) => { const result = await read(...args); if (mode === "cached") mutate(); return result; };
    const ask = vi.fn(async () => { mutate(); return countingJev("low").ask(); });
    const [record] = await screen([readme()], { ...quiet, files: acquisition.files, marker: github.io, ask });
    expect(record).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE, cache_hit: false });
    expect(github.posts()).toHaveLength(0);
    expect(ask).toHaveBeenCalledTimes(mode === "fresh" ? 1 : 0);
  });

  it("protects the acquisition helper with the existing sensitive-path policy", () => {
    const imported = readFileSync(new URL("./jev-pr-screen.mjs", import.meta.url), "utf8").match(/from "([^"]*screen-files\.mjs)"/)?.[1];
    expect(imported).toBeTruthy();
    const actualPath = relative(repoRoot, fileURLToPath(new URL(imported, new URL("./jev-pr-screen.mjs", import.meta.url))));
    expect(deterministicTier({ deterministic: "low", files: [actualPath] }, loadSensitivePaths({ root: repoRoot })))
      .toMatchObject({ tier: "risky", sensitiveClasses: ["infra_ci"] });
  });
});

describe("OVD-961 malformed status admission", () => {
  it.each([
    ["absent", {}],
    ["undefined", { status: undefined }],
    ["null", { status: null }],
    ["unknown", { status: "unknown" }],
    ["empty", { status: "" }],
    ["wrong case", { status: "RENAMED" }],
    ["whitespace", { status: " modified " }],
    ["number", { status: 1 }],
    ["boolean", { status: true }],
    ["array", { status: ["modified"] }],
    ["object", { status: { value: "modified" } }],
    ["prototype name", { status: "toString" }],
  ])("fails closed before cache or Jev for %s status", async (_label, fields) => {
    const marker = { headSha: vi.fn(), read: vi.fn(), write: vi.fn() };
    const ask = vi.fn();
    const acquisition = mutableAcquisition([{ filename: "docs/retired.md", ...fields }]);
    const [record] = await screen([readme()], { ...quiet, files: acquisition.files, marker, ask });
    expect(record).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE, cache_hit: false });
    for (const fn of [...Object.values(marker), ask]) expect(fn).not.toHaveBeenCalled();
  });

  it.each(["added", "removed", "modified", "changed", "unchanged", "renamed", "copied"])
  ("accepts supported %s status with complete affected paths", async (status) => {
    const moves = status === "renamed" || status === "copied";
    const entry = { filename: "docs/retired.md", status, ...(moves ? { previous_filename: ".github/workflows/required.yml" } : {}) };
    const acquisition = mutableAcquisition([entry]);
    const github = fakeGitHub({ heads: { 846: SHA } });
    const ask = vi.fn(countingJev("low").ask);
    const [record] = await screen([readme()], { ...quiet, files: acquisition.files, marker: github.io, ask });
    expect(record).toMatchObject({ final: moves ? "risky" : "low", filesProblem: null });
    const paths = moves ? [entry.filename, entry.previous_filename] : [entry.filename];
    expect(ask.mock.calls[0][0].files).toEqual(paths);
    expect(parseMarkerDescription(github.store[SHA][0].description).stateHash).toBe(hashScreenState(ask.mock.calls[0][0], BASE));
  });

  it("rejects a malformed status on a later page before any screening/cache calls", async () => {
    const records = [...Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md`, status: "modified" })), { filename: "docs/retired.md", status: null }];
    const run = (args) => {
      const page = /\/files\?per_page=100&page=(\d+)$/.exec(args[1]);
      if (page) return JSON.stringify(records.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100));
      return JSON.stringify({ head: { sha: SHA }, base: { sha: OTHER_SHA }, changed_files: records.length });
    };
    const marker = { headSha: vi.fn(), read: vi.fn(), write: vi.fn() };
    const ask = vi.fn();
    const [record] = await screen([readme()], { ...quiet, files: (pr, sha) => verifiedPrFiles(pr, sha, { run }), marker, ask });
    expect(record).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE });
    for (const fn of [...Object.values(marker), ask]) expect(fn).not.toHaveBeenCalled();
  });
});

/** A Jev stub that answers each call from a list (the last answer repeats) and records what it was sent. */
function scriptedJev(...choices) {
  const jev = { calls: 0, sent: [] };
  jev.ask = async (state) => {
    const choice = choices[Math.min(jev.calls, choices.length - 1)];
    jev.calls += 1;
    jev.sent.push(state);
    return { ok: true, model: JEV_MODEL, answers: { tier: { type: "choice", choice, confidence: 0.99 }, incident: { type: "noul", noul: 0 } }, latencyMs: 1 };
  };
  return jev;
}

describe("OVD-934 screen state digest", () => {
  const STATE = { title: "Docs", files: ["docs/a.md", "docs/b.md"], additions: 3, deletions: 2, notes: "n" };

  it("hashes the exact state and base: every field, the file order and the base each change the digest", () => {
    const digest = hashScreenState(STATE, BASE);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashScreenState({ notes: "n", deletions: 2, additions: 3, files: ["docs/a.md", "docs/b.md"], title: "Docs" }, BASE)).toBe(digest);
    const changed = [
      { ...STATE, title: "Doc" },
      { ...STATE, notes: "m" },
      { ...STATE, additions: 4 },
      { ...STATE, deletions: 3 },
      { ...STATE, additions: null },
      { ...STATE, files: ["docs/b.md", "docs/a.md"] },
      { ...STATE, files: ["docs/a.md"] },
      { ...STATE, files: ["docs/a.md\ndocs/b.md"] },
    ];
    for (const state of changed) expect(hashScreenState(state, BASE), JSON.stringify(state)).not.toBe(digest);
    expect(hashScreenState(STATE, SHA)).not.toBe(digest);
    expect(hashScreenState(STATE, null)).not.toBe(digest);
    expect(hashScreenState({ ...STATE, files: ["a\nb", "c"] }, BASE)).not.toBe(hashScreenState({ ...STATE, files: ["a", "b\nc"] }, BASE));
  });

  /** Screen the same PR head with a given state, sharing one fake GitHub and one scripted Jev across calls. */
  function harness() {
    const github = fakeGitHub({ heads: { 846: SHA } });
    const jev = scriptedJev("low", "risky");
    const run = async ({ pr = {}, paths = STATE.files, base = BASE } = {}) => {
      const input = { ...readme(), title: STATE.title, notes: STATE.notes, additions: STATE.additions, deletions: STATE.deletions, ...pr };
      const [record] = await screen([input], { ...quiet, files: () => acq(paths, base), ask: jev.ask, marker: github.io });
      return record;
    };
    return { github, jev, run };
  }

  it("an unchanged input is a hit with zero further Jev calls", async () => {
    const { github, jev, run } = harness();
    expect(await run()).toMatchObject({ cache_hit: false, final: "low" });
    expect(jev.calls).toBe(1);
    expect(await run()).toMatchObject({ cache_hit: true, marker_hit: true, final: "low", tokens: null });
    expect(jev.calls).toBe(1);
    expect(github.posts()).toHaveLength(1);
  });

  it.each([
    ["title", { pr: { title: "Docs, reworded" } }],
    ["notes", { pr: { notes: "changed notes" } }],
    ["additions", { pr: { additions: 4 } }],
    ["deletions", { pr: { deletions: 3 } }],
    ["base identity", { base: "1".repeat(40) }],
    ["file order", { paths: ["docs/b.md", "docs/a.md"] }],
    ["same paths retargeted to another base with other sizes", { base: "2".repeat(40), pr: { additions: 40, deletions: 30 } }],
  ])("a changed %s alone is a miss and runs Jev again", async (_name, change) => {
    const { jev, run } = harness();
    expect(await run()).toMatchObject({ cache_hit: false, final: "low" });
    const second = await run(change);
    expect(jev.calls).toBe(2);
    expect(second).toMatchObject({ cache_hit: false, marker_hit: false, final: "risky" });
    // Jev was sent exactly the changed state, in the order given.
    expect(jev.sent[1].files).toEqual(change.paths ?? STATE.files);
  });

  it("treats the rename-order example as a miss: same sorted paths, different Jev input", async () => {
    const { github, jev } = harness();
    const before = mutableAcquisition([{ filename: "docs/c.md", previous_filename: "docs/b.md", status: "renamed" }]);
    const after = mutableAcquisition([{ filename: "docs/b.md", status: "removed" }, { filename: "docs/c.md", status: "modified" }]);
    const screenWith = async (acquisition) => (await screen([readme()], { ...quiet, files: acquisition.files, ask: jev.ask, marker: github.io }))[0];
    expect(await screenWith(before)).toMatchObject({ cache_hit: false, final: "low" });
    expect(jev.sent[0].files).toEqual(["docs/c.md", "docs/b.md"]);
    // Re-screening the rename is a hit; the removal plus modification is a different input.
    expect(await screenWith(before)).toMatchObject({ cache_hit: true, final: "low" });
    expect(jev.calls).toBe(1);
    expect(await screenWith(after)).toMatchObject({ cache_hit: false, final: "risky" });
    expect(jev.calls).toBe(2);
    expect(jev.sent[1].files).toEqual(["docs/b.md", "docs/c.md"]);
  });

  it("uses one digest for the lookup, the write and the posted marker, and it is the digest of what Jev was sent", async () => {
    const github = fakeGitHub({ heads: { 846: SHA } });
    const reads = [];
    const writes = [];
    const marker = {
      ...github.io,
      read: (...args) => {
        reads.push(args);
        return github.io.read(...args);
      },
      write: (sha, written) => {
        writes.push(written);
        return github.io.write(sha, written);
      },
    };
    const jev = scriptedJev("low");
    const input = { ...readme(), title: STATE.title, notes: STATE.notes, additions: STATE.additions, deletions: STATE.deletions };
    await screen([input], { ...quiet, files: () => acq(STATE.files), ask: jev.ask, marker });
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(1);
    const expected = hashScreenState({ title: STATE.title, files: STATE.files, additions: 3, deletions: 2, notes: "n" }, BASE);
    expect(reads[0][3]).toBe(expected);
    expect(writes[0].stateHash).toBe(expected);
    expect(parseMarkerDescription(github.store[SHA][0].description).stateHash).toBe(expected);
    expect(hashScreenState(jev.sent[0], BASE)).toBe(expected);
  });

  it("fails closed, with no cache or Jev access, when the acquisition has no verified base commit", async () => {
    for (const acquisition of [
      { paths: ["README.md"], revalidate: () => {} },
      { ...acq(["README.md"]), snapshot: undefined },
      acq(["README.md"], null),
      acq(["README.md"], "abc123"),
      acq(["README.md"], `${BASE}0`),
      acq(["README.md"], 42),
    ]) {
      const marker = { read: vi.fn(), write: vi.fn(), headSha: vi.fn() };
      const ask = vi.fn();
      const [record] = await screen([readme()], { ...quiet, files: () => acquisition, marker, ask });
      expect(record, JSON.stringify(acquisition.snapshot)).toMatchObject({ final: "no_verdict", filesProblem: FILES_INCOMPLETE, cache_hit: false });
      for (const fn of [...Object.values(marker), ask]) expect(fn).not.toHaveBeenCalled();
    }
    // The base is compared case-insensitively: an upper-case SHA is the same base.
    const github = fakeGitHub({ heads: { 846: SHA } });
    const jev = scriptedJev("low");
    await screen([readme()], { ...quiet, files: () => acq(["README.md"], BASE.toUpperCase()), ask: jev.ask, marker: github.io });
    const [again] = await screen([readme()], { ...quiet, files: () => acq(["README.md"], BASE), ask: jev.ask, marker: github.io });
    expect(again).toMatchObject({ cache_hit: true });
    expect(jev.calls).toBe(1);
  });

  it("rejects v1 and v2 markers as a whole-read miss, so they can never lower the tier", async () => {
    const v2 = `v2 tier=low jev=low c=0.99 p=0 model=${JEV_MODEL} q=${Q} screener=mjs f=${F}`;
    const v1 = `v1 tier=low jev=low c=0.99 p=0 model=${JEV_MODEL} q=${Q} screener=mjs`;
    const sound = markerText({ tier: "low", jevTier: "low", confidence: 0.99 });
    const v3WithOldField = sound.replace(" s=", " f=");
    expect(MARKER_VERSION).toBe("v3");
    expect(parseMarkerDescription(sound)).not.toBeNull();
    for (const old of [v2, v1, v3WithOldField]) {
      expect(parseMarkerDescription(old), old).toBeNull();
      // Next to a sound v3 marker for the same key, the old marker still forces a miss.
      for (const statuses of [[status(old), status(sound)], [status(sound), status(old)]]) {
        const github = fakeGitHub({ statuses: { [SHA]: statuses } });
        expect(await readMarker(SHA, JEV_MODEL, Q, F, { run: github.run }), old).toEqual({ found: false, reason: "rejected_marker" });
      }
      const github = fakeGitHub({ heads: { 846: SHA }, statuses: { [SHA]: [status(old)] } });
      const jev = scriptedJev("risky");
      const [record] = await screen([readme()], { ...quiet, files: () => acq(["README.md"]), ask: jev.ask, marker: github.io });
      expect(jev.calls, old).toBe(1);
      expect(record, old).toMatchObject({ cache_hit: false, final: "risky" });
    }
  });

  it("keeps the longest legal marker within GitHub's 140 character cap", async () => {
    const longest = { tier: "normal", jevTier: "normal", confidence: 0.999, pIncident: 0.999, questionHash: "f".repeat(8), stateHash: F };
    // "normal" is the longest tier name; a 22 character model is the longest that fits exactly.
    expect(buildMarkerDescription({ ...longest, model: "m".repeat(22) })).toHaveLength(MAX_DESCRIPTION_LENGTH);
    expect(buildMarkerDescription({ ...longest, model: JEV_MODEL }).length).toBeLessThan(MAX_DESCRIPTION_LENGTH);
    expect(buildMarkerDescription({ ...longest, tier: "risky", jevTier: "normal", model: JEV_MODEL }).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    const fits = fakeGitHub();
    expect(await writeMarker(SHA, { ...longest, model: "m".repeat(22) }, { run: fits.run })).toEqual({ success: true });
    expect(parseMarkerDescription(fits.store[SHA][0].description)).toMatchObject({ model: "m".repeat(22), stateHash: F });
    const over = fakeGitHub();
    expect(await writeMarker(SHA, { ...longest, model: "m".repeat(23) }, { run: over.run })).toEqual({ success: false, reason: "description_too_long" });
    expect(over.calls).toEqual([]);
    // A longer description is also refused on read.
    expect(parseMarkerDescription(buildMarkerDescription({ ...longest, model: "m".repeat(23) }))).toBeNull();
  });
});
