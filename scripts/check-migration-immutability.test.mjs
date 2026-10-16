// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKER_PATH,
  DEFAULT_APPROVER,
  GATE_LOOSENING_LINE,
  NODE_TEST_PATH,
  OVERRIDE_LABEL,
  checkerWorkflowSurface,
  evaluateOverride,
  parseGitHubTimestamp,
  parseRawDiff,
  parseTimeline,
  run,
} from "./check-migration-immutability.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtures = join(repoRoot, "scripts/fixtures/migration-immutability");
// The CI job is a card draft (docs/migration-immutability.md), not yet in ci.yml.
const ciPath = join(fixtures, "ci-job.draft.yml");
const temps = [];
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const OLD = "supabase/migrations/20260101000000_widgets.sql";
const NEWEST = "supabase/migrations/20260102000000_widget_note.sql";
const LATER = "supabase/migrations/20260201000000_widget_tags.sql";

/**
 * Fixtures keep migrations/ at their root, not under supabase/, so no fixture
 * path contains supabase/migrations/ (the migration guardrails match that
 * anywhere). copyFixture maps them back into a repo layout.
 */
const FIXTURE_DIRS = { migrations: "supabase/migrations" };
function copyFixture(src, dir) {
  for (const name of readdirSync(src)) cpSync(join(src, name), join(dir, FIXTURE_DIRS[name] ?? name), { recursive: true });
}

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

/** Write each { path: content } under dir; a null content deletes the path. */
function writeTree(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content == null) {
      rmSync(full, { force: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

function commitAll(dir, message) {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message, "--allow-empty");
}

/**
 * Two-commit repo from _base: base gets baseFiles, then head applies headOps.
 * headOps: { path: content | null (delete) } or a function(dir) for git-level edits.
 */
function overlayRepo(baseFiles, headOps) {
  const dir = mkdtempSync(join(tmpdir(), "migration-immutability-"));
  temps.push(dir);
  git(dir, "init", "-q");
  copyFixture(join(fixtures, "_base"), dir);
  writeTree(dir, baseFiles);
  commitAll(dir, "base");
  if (typeof headOps === "function") headOps(dir);
  else writeTree(dir, headOps);
  commitAll(dir, "head");
  return dir;
}

function runCli(args) {
  let out = "";
  let err = "";
  const code = run(args, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

function check(dir, extra = []) {
  const { code, out } = runCli(["--root", dir, "--base-ref", "HEAD^1", "--head-ref", "HEAD", "--json", ...extra]);
  return { code, report: JSON.parse(out) };
}

const kinds = (report) => report.findings.map((f) => `${f.kind}:${f.path}`);

/** Timestamps exactly as GitHub writes them, with the instant each one means. */
const GITHUB_TIMESTAMPS = [
  ["2026-10-10T09:00:00Z", Date.UTC(2026, 9, 10, 9, 0, 0)],
  ["2026-10-10T09:00:00.123Z", Date.UTC(2026, 9, 10, 9, 0, 0, 123)],
  ["2026-10-10T09:00:00.000Z", Date.UTC(2026, 9, 10, 9, 0, 0)],
  ["2026-12-31T23:59:59.999Z", Date.UTC(2026, 11, 31, 23, 59, 59, 999)],
  ["2028-02-29T00:00:00Z", Date.UTC(2028, 1, 29)],
  // A shorter fraction is the same instant once padded to milliseconds.
  ["2026-10-10T09:00:00.5Z", Date.UTC(2026, 9, 10, 9, 0, 0, 500)],
];

/**
 * Values that are not a GitHub timestamp. Several of them Date.parse reads as
 * real dates ("1", "2026", "Oct 10", 0, [0], 2026-02-30 -> March 2), which is
 * how a malformed event used to be ordered as a genuine one.
 */
const UNUSABLE_TIMESTAMPS = [
  ["undefined", undefined],
  ["null", null],
  ["number 0", 0],
  ["number 1", 1],
  ["epoch milliseconds", Date.UTC(2026, 9, 10, 10)],
  ["NaN", Number.NaN],
  ["true", true],
  ["an object", {}],
  ["an object whose toString is valid", { toString: () => "2026-10-10T10:00:00Z" }],
  ["a Date object", new Date("2026-10-10T10:00:00Z")],
  ["[0]", [0]],
  ["an array holding a valid string", ["2026-10-10T10:00:00Z"]],
  ["empty string", ""],
  ['"not a date"', "not a date"],
  ['"0"', "0"],
  ['"1"', "1"],
  ['"2026"', "2026"],
  ['"2027"', "2027"],
  ['"Oct 10"', "Oct 10"],
  ['"Oct 10 2026"', "Oct 10 2026"],
  ["a date with no time", "2026-10-10"],
  ['"2026-10-10 9:00"', "2026-10-10 9:00"],
  ['"2026-10-10 09:00:00"', "2026-10-10 09:00:00"],
  ["no Z", "2026-10-10T09:00:00"],
  ["no seconds", "2026-10-10T09:00Z"],
  ["an offset instead of Z", "2026-10-10T09:00:00+00:00"],
  ["lowercase t and z", "2026-10-10t09:00:00z"],
  ["a leading space", " 2026-10-10T09:00:00Z"],
  ["a trailing newline", "2026-10-10T09:00:00Z\n"],
  ["an expanded year", "+002026-10-10T09:00:00Z"],
  ["a negative expanded year", "-002026-10-10T09:00:00Z"],
  ["an empty fraction", "2026-10-10T09:00:00.Z"],
  ["a fraction finer than a millisecond", "2026-10-10T09:00:00.123456Z"],
  ["February 30 (Date.parse rolls it to March 2)", "2026-02-30T00:00:00Z"],
  ["February 29 in a non-leap year", "2026-02-29T00:00:00Z"],
  ["April 31", "2026-04-31T00:00:00Z"],
  ["month 13", "2026-13-01T00:00:00Z"],
  ["24:00:00 (Date.parse rolls it to the next day)", "2026-10-10T24:00:00Z"],
  ["a leap second", "2026-10-10T23:59:60Z"],
];

describe("status rule (only A passes)", () => {
  it("passes a new migration that sorts after the newest base timestamp", () => {
    const { code, report } = check(overlayRepo({}, { [LATER]: "select 1;\n" }), ["--enforce"]);
    expect(code).toBe(0);
    expect(report).toMatchObject({ ok: true, findings: [], added: [LATER], newestBaseTimestamp: "20260102000000" });
    expect(report.gate_loosening.detected).toBe(false);
  });

  it("fails an edited migration (M) and exits 1 only with --enforce", () => {
    const dir = overlayRepo({}, { [OLD]: "create table public.widgets (id uuid primary key, sneaky text);\n" });
    expect(kinds(check(dir).report)).toEqual([`modified:${OLD}`]);
    expect(check(dir).code).toBe(0);
    expect(check(dir, ["--enforce"]).code).toBe(1);
  });

  it("fails a deleted migration (D)", () => {
    expect(kinds(check(overlayRepo({}, { [OLD]: null })).report)).toEqual([`deleted:${OLD}`]);
  });

  it("fails a rename that keeps the content the same (R100)", () => {
    const renamed = "supabase/migrations/20260301000000_widgets.sql";
    const { report } = check(overlayRepo({}, (dir) => git(dir, "mv", OLD, renamed)));
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([expect.objectContaining({ kind: "renamed", status: "R", oldPath: OLD, path: renamed })]);
    expect(report.findings[0].message).toContain("content unchanged");
    expect(report.added).toEqual([]);
  });

  it("fails an edited rename as a delete plus an add", () => {
    const renamed = "supabase/migrations/20260301000000_widgets_v2.sql";
    const { report } = check(overlayRepo({}, { [OLD]: null, [renamed]: "create table public.widgets_v2 (id uuid);\n" }));
    expect(kinds(report)).toEqual([`deleted:${OLD}`]);
    expect(report.added).toEqual([renamed]);
  });

  it("fails an exact copy of an existing migration (C)", () => {
    const copy = "supabase/migrations/20260301000000_widgets_again.sql";
    const { report } = check(overlayRepo({}, { [copy]: readFileSync(join(fixtures, "_base/migrations/20260101000000_widgets.sql"), "utf8") }));
    expect(report.findings).toEqual([expect.objectContaining({ kind: "copied", status: "C", oldPath: OLD, path: copy })]);
  });

  it("fails a mode-only change", () => {
    const { report } = check(overlayRepo({}, (dir) => {
      chmodSync(join(dir, OLD), 0o755);
      git(dir, "update-index", "--chmod=+x", OLD);
    }));
    expect(report.findings).toEqual([expect.objectContaining({ kind: "mode_changed", status: "M", path: OLD })]);
    expect(report.findings[0].message).toContain("100644 -> 100755 (content unchanged)");
  });

  it("ignores changes outside supabase/migrations", () => {
    const { report } = check(overlayRepo({ "docs/notes.md": "a\n" }, { "docs/notes.md": "b\n", "supabase/tests/x.sql": "select 1;\n" }), ["--enforce"]);
    expect(report).toMatchObject({ ok: true, findings: [], added: [] });
  });
});

describe("backdating", () => {
  it("fails a new file whose timestamp sorts before the newest base timestamp", () => {
    const backdated = "supabase/migrations/20260101120000_backdated.sql";
    const { report } = check(overlayRepo({}, { [backdated]: "select 1;\n" }));
    expect(report.ok).toBe(false);
    expect(report.findings).toEqual([expect.objectContaining({ kind: "backdated", status: "A", path: backdated, timestamp: "20260101120000", newestBaseTimestamp: "20260102000000" })]);
    expect(report.findings[0].message).toContain("cannot be backdated");
  });

  it("fails a new file that reuses the newest base timestamp", () => {
    const same = "supabase/migrations/20260102000000_same_stamp.sql";
    expect(kinds(check(overlayRepo({}, { [same]: "select 1;\n" })).report)).toEqual([`backdated:${same}`]);
  });

  it("fails badly named and duplicate-timestamp additions", () => {
    const { report } = check(overlayRepo({}, {
      "supabase/migrations/add_widgets.sql": "select 1;\n",
      "supabase/migrations/nested/20260301000000_x.sql": "select 1;\n",
      "supabase/migrations/20260301000000_a.sql": "select 1;\n",
      "supabase/migrations/20260301000000_b.sql": "select 2;\n",
    }));
    expect(kinds(report).sort()).toEqual([
      "duplicate_timestamp:supabase/migrations/20260301000000_b.sql",
      "invalid_name:supabase/migrations/add_widgets.sql",
      "invalid_name:supabase/migrations/nested/20260301000000_x.sql",
    ]);
  });
});

describe("parseGitHubTimestamp (the checker's one timestamp parser)", () => {
  it.each(GITHUB_TIMESTAMPS)("accepts %s", (value, ms) => {
    expect(parseGitHubTimestamp(value)).toBe(ms);
  });

  it.each(UNUSABLE_TIMESTAMPS)("rejects %s as unusable", (_name, value) => {
    expect(parseGitHubTimestamp(value)).toBeNull();
  });

  it("is the only place the checker parses a date", () => {
    const code = readFileSync(join(repoRoot, CHECKER_PATH), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
    expect(code.filter((line) => line.includes("Date.parse(")).map((line) => line.trim())).toEqual(["const ms = Date.parse(value);"]);
    // new Date only re-serializes instants that already came out of the helper.
    expect(code.filter((line) => line.includes("new Date(")).map((line) => /new Date\((\w+)\)/.exec(line)?.[1])).toEqual(["ms", "pushedAt"]);
  });
});

describe("migration-edit-approved override", () => {
  const PUSHED_AT = "2026-10-10T08:00:00Z";
  const HEAD = "a".repeat(40);
  const labeled = (login, createdAt, name = OVERRIDE_LABEL) => ({ event: "labeled", created_at: createdAt, actor: { login }, label: { name } });
  const decide = (timeline, extra = {}) => evaluateOverride({ timeline, headSha: HEAD, headPushedAt: PUSHED_AT, ...extra });

  it("counts Blaine's label applied after the head was pushed", () => {
    const timeline = parseTimeline(readFileSync(join(fixtures, "timeline.json"), "utf8"));
    expect(decide(timeline)).toMatchObject({ status: "approved", applied: true, approver: DEFAULT_APPROVER, event: { actor: "optomachina" } });
    expect(DEFAULT_APPROVER).toBe("optomachina");
  });

  it("ignores a label applied before the latest push", () => {
    const result = decide([labeled("optomachina", "2026-10-10T07:59:59Z")]);
    expect(result).toMatchObject({ status: "ignored", applied: false });
    expect(result.reason).toContain("a new push voids it");
  });

  it("ignores a label once a later force push moves the head", () => {
    const result = decide([labeled("optomachina", "2026-10-10T09:00:00Z"), { event: "head_ref_force_pushed", created_at: "2026-10-10T09:30:00Z" }]);
    expect(result).toMatchObject({ status: "ignored", headPushedAt: "2026-10-10T09:30:00.000Z" });
  });

  it("ignores a label applied by a non-Blaine actor, and a parametrized approver changes that", () => {
    const timeline = [labeled("someone-else", "2026-10-10T09:00:00Z")];
    const result = decide(timeline);
    expect(result).toMatchObject({ status: "ignored", applied: false });
    expect(result.reason).toContain("applied by someone-else, not optomachina");
    expect(decide(timeline, { approver: "Someone-Else" }).status).toBe("approved");
  });

  it("uses only the latest label event: removed, or re-applied by someone else, does not count", () => {
    expect(decide([labeled("optomachina", "2026-10-10T09:00:00Z"), { ...labeled("optomachina", "2026-10-10T09:10:00Z"), event: "unlabeled" }]).status).toBe("not_applied");
    expect(decide([labeled("optomachina", "2026-10-10T09:00:00Z"), { ...labeled("x", "2026-10-10T09:10:00Z"), event: "unlabeled" }, labeled("x", "2026-10-10T09:20:00Z")]).status).toBe("ignored");
    expect(decide([labeled("optomachina", "2026-10-10T09:00:00Z", "other-label")]).status).toBe("not_applied");
  });

  it("fails closed without a timeline, head SHA or push time", () => {
    const timeline = [labeled("optomachina", "2026-10-10T09:00:00Z")];
    expect(evaluateOverride({}).status).toBe("unavailable");
    expect(evaluateOverride({ timelineError: "boom", timeline }).status).toBe("unavailable");
    expect(decide(timeline, { headSha: null }).status).toBe("unavailable");
    expect(decide(timeline, { headPushedAt: "not a date" }).status).toBe("unavailable");
  });

  it("fails closed on a force-push or restore event with no usable created_at", () => {
    const approved = labeled("optomachina", "2026-10-10T09:00:00Z");
    expect(decide([approved]).status).toBe("approved");
    for (const event of ["head_ref_force_pushed", "head_ref_restored"]) {
      for (const undated of [{ event }, { event, created_at: null }, { event, created_at: "not a date" }]) {
        const result = decide([approved, undated]);
        expect(result).toMatchObject({ status: "unavailable", applied: false });
        expect(result.reason).toContain(`${event} event has no usable created_at`);
      }
    }
    const dir = overlayRepo({}, { [OLD]: "-- edited\n" });
    const timeline = join(dir, "timeline.ndjson");
    writeFileSync(timeline, [approved, { event: "head_ref_force_pushed" }].map((event) => JSON.stringify(event)).join("\n"));
    const { code, report } = check(dir, ["--enforce", "--timeline", timeline, "--head-sha", HEAD, "--head-pushed-at", PUSHED_AT]);
    expect(code).toBe(1);
    expect(report).toMatchObject({ ok: false, waived: false, override: { status: "unavailable" } });
  });

  it("fails closed on a label event with no usable created_at, instead of reading it as time 0", () => {
    const approved = labeled("optomachina", "2026-10-10T09:00:00Z");
    const undatedValues = [undefined, null, "", "not a date"];
    for (const createdAt of undatedValues) {
      // Blaine removed the label, but the removal cannot be dated: still not approved.
      const removed = decide([approved, { ...labeled("optomachina", createdAt), event: "unlabeled" }]);
      expect(removed).toMatchObject({ status: "unavailable", applied: false, reason: "label event has no usable created_at" });
      // Someone else re-applied it, but undated: must not be ignored as time 0.
      const relabeled = decide([approved, labeled("someone-else", createdAt)]);
      expect(relabeled).toMatchObject({ status: "unavailable", applied: false, reason: "label event has no usable created_at" });
      // An undated first event is no better.
      expect(decide([labeled("optomachina", createdAt), approved]).status).toBe("unavailable");
    }
    // The approver's valid label alone still counts, so the cases above flipped it.
    expect(decide([approved]).status).toBe("approved");
  });

  // Each timestamp an approval decision reads. valid shows the same timeline
  // decides normally with a GitHub timestamp, so "unavailable" comes from the
  // unusable value alone.
  const decisionPaths = [
    { path: "head push time", valid: "2026-10-10T08:00:00Z", validStatus: "approved", reason: "no usable head push time given", decideAt: (at) => decide([labeled("optomachina", "2026-10-10T09:00:00Z")], { headPushedAt: at }) },
    { path: "head_ref_force_pushed created_at", valid: "2026-10-10T08:30:00Z", validStatus: "approved", reason: "head_ref_force_pushed event has no usable created_at", decideAt: (at) => decide([labeled("optomachina", "2026-10-10T09:00:00Z"), { event: "head_ref_force_pushed", created_at: at }]) },
    { path: "head_ref_restored created_at", valid: "2026-10-10T08:30:00Z", validStatus: "approved", reason: "head_ref_restored event has no usable created_at", decideAt: (at) => decide([labeled("optomachina", "2026-10-10T09:00:00Z"), { event: "head_ref_restored", created_at: at }]) },
    { path: "labeled created_at (Blaine's lone label)", valid: "2026-10-10T09:00:00Z", validStatus: "approved", reason: "label event has no usable created_at", decideAt: (at) => decide([labeled("optomachina", at)]) },
    { path: "labeled created_at (a later relabel by someone else)", valid: "2026-10-10T09:10:00Z", validStatus: "ignored", reason: "label event has no usable created_at", decideAt: (at) => decide([labeled("optomachina", "2026-10-10T09:00:00Z"), labeled("someone-else", at)]) },
    { path: "unlabeled created_at (Blaine removes the label)", valid: "2026-10-10T09:10:00Z", validStatus: "not_applied", reason: "label event has no usable created_at", decideAt: (at) => decide([labeled("optomachina", "2026-10-10T09:00:00Z"), { ...labeled("optomachina", at), event: "unlabeled" }]) },
  ];

  it.each(decisionPaths)("fails closed on every unusable $path", ({ valid, validStatus, reason, decideAt }) => {
    expect(decideAt(valid).status).toBe(validStatus);
    for (const [name, value] of UNUSABLE_TIMESTAMPS) {
      const result = decideAt(value);
      expect(result.status, name).toBe("unavailable");
      expect(result.applied, name).toBe(false);
      expect(result.reason, name).toContain(reason);
    }
  });

  it("fails closed end to end on timestamps Date.parse accepts but GitHub never sends", () => {
    const dir = overlayRepo({}, { [OLD]: "-- edited\n" });
    const timeline = join(dir, "timeline.ndjson");
    const approved = labeled("optomachina", "2026-10-10T09:00:00Z");
    const cli = (events, pushedAt = PUSHED_AT) => {
      writeFileSync(timeline, events.map((event) => JSON.stringify(event)).join("\n"));
      return check(dir, ["--enforce", "--timeline", timeline, "--head-sha", HEAD, "--head-pushed-at", pushedAt]);
    };
    expect(cli([approved])).toMatchObject({ code: 0, report: { ok: true, waived: true, override: { status: "approved" } } });
    // Blaine's removal dated "Oct 10 2026" used to read as an old date and leave the waiver applied.
    expect(cli([approved, { ...labeled("optomachina", "Oct 10 2026"), event: "unlabeled" }])).toMatchObject({ code: 1, report: { ok: false, waived: false, override: { status: "unavailable", reason: "label event has no usable created_at" } } });
    expect(cli([approved, { event: "head_ref_force_pushed", created_at: 0 }])).toMatchObject({ code: 1, report: { ok: false, override: { status: "unavailable" } } });
    expect(cli([approved], "2026-10-10 08:00:00")).toMatchObject({ code: 1, report: { ok: false, override: { status: "unavailable", reason: "no usable head push time given" } } });
  });

  it("ignores an undated event for an unrelated label, or a non-label event", () => {
    const approved = labeled("optomachina", "2026-10-10T09:00:00Z");
    for (const [name, createdAt] of UNUSABLE_TIMESTAMPS) {
      expect(decide([approved, labeled("someone-else", createdAt, "documentation")]).status, name).toBe("approved");
      expect(decide([approved, { ...labeled("someone-else", createdAt, "documentation"), event: "unlabeled" }]).status, name).toBe("approved");
      expect(decide([approved, { event: "commented", created_at: createdAt }]).status, name).toBe("approved");
    }
    expect(decide([labeled("optomachina", "2026-10-10T09:00:00Z", "documentation")]).status).toBe("not_applied");
  });

  it("fails closed end to end when an unlabel event has no created_at", () => {
    const dir = overlayRepo({}, { [OLD]: "-- edited\n" });
    const timeline = join(dir, "timeline.ndjson");
    const undatedUnlabel = { event: "unlabeled", actor: { login: "optomachina" }, label: { name: OVERRIDE_LABEL } };
    writeFileSync(timeline, [labeled("optomachina", "2026-10-10T09:00:00Z"), undatedUnlabel].map((event) => JSON.stringify(event)).join("\n"));
    const { code, report } = check(dir, ["--enforce", "--timeline", timeline, "--head-sha", HEAD, "--head-pushed-at", PUSHED_AT]);
    expect(code).toBe(1);
    expect(report).toMatchObject({ ok: false, waived: false, override: { status: "unavailable", reason: "label event has no usable created_at" } });
    expect(report.gate_loosening.detected).toBe(false);
  });

  it("waives findings end to end and reports the waiver as gate_loosening", () => {
    const dir = overlayRepo({}, { [OLD]: "-- edited\n" });
    const timeline = join(dir, "timeline.ndjson");
    writeFileSync(timeline, `${JSON.stringify(labeled("optomachina", "2026-10-10T09:00:00Z"))}\n`);
    const { code, report } = check(dir, ["--enforce", "--timeline", timeline, "--head-sha", HEAD, "--head-pushed-at", PUSHED_AT]);
    expect(code).toBe(0);
    expect(report).toMatchObject({ ok: true, waived: true, override: { status: "approved" } });
    expect(kinds(report)).toEqual([`modified:${OLD}`]);
    expect(report.gate_loosening).toEqual({
      detected: true,
      reasons: [expect.objectContaining({ kind: "override_used", label: OVERRIDE_LABEL, actor: "optomachina", paths: [OLD] })],
      requires: ["grokbot_countersign", "blaine_card"],
    });
    const human = runCli(["--root", dir, "--base-ref", "HEAD^1", "--head-ref", "HEAD", "--timeline", timeline, "--head-sha", HEAD, "--head-pushed-at", PUSHED_AT]).out;
    expect(human).toContain(`WAIVED ${OLD} is modified.`);
    expect(human).toContain(GATE_LOOSENING_LINE);
  });

  it("a stale label does not waive anything", () => {
    const dir = overlayRepo({}, { [OLD]: "-- edited\n" });
    const timeline = join(dir, "timeline.json");
    writeFileSync(timeline, JSON.stringify([[labeled("optomachina", "2026-10-10T07:00:00Z")]]));
    const { code, report } = check(dir, ["--enforce", "--timeline", timeline, "--head-sha", HEAD, "--head-pushed-at", PUSHED_AT]);
    expect(code).toBe(1);
    expect(report).toMatchObject({ ok: false, waived: false, override: { status: "ignored" } });
    expect(report.gate_loosening.detected).toBe(false);
  });
});

describe("gate_loosening (checker and CI job)", () => {
  const workflow = (step) => [
    "jobs:",
    "  lint:",
    "    runs-on: ubuntu-latest",
    "  migration-immutability:",
    "    continue-on-error: true",
    "    steps:",
    `      - run: ${step}`,
    "  # next job",
    "  ci:",
    "    needs:",
    "      - lint",
    "",
  ].join("\n");

  it("detects an edited or removed checker but not a new one", () => {
    const reasons = (dir) => check(dir).report.gate_loosening.reasons.map((r) => r.kind);
    expect(reasons(overlayRepo({ [CHECKER_PATH]: "// base\n" }, { [CHECKER_PATH]: "// relaxed\n" }))).toEqual(["checker_changed"]);
    expect(reasons(overlayRepo({ [CHECKER_PATH]: "// base\n" }, { [CHECKER_PATH]: null }))).toEqual(["checker_removed"]);
    expect(reasons(overlayRepo({}, { [CHECKER_PATH]: "// new\n" }))).toEqual([]);
  });

  it("detects changes to the CI job and its references, ignoring unrelated workflow edits", () => {
    const path = ".github/workflows/ci.yml";
    const base = workflow("node checker --base-ref HEAD^1");
    const reasons = (head) => check(overlayRepo({ [path]: base }, { [path]: head })).report.gate_loosening.reasons.map((r) => r.kind);
    expect(reasons(base.replace("--base-ref HEAD^1", "--base-ref HEAD"))).toEqual(["ci_job_changed"]);
    expect(reasons(base.replace("      - lint\n", "      - lint\n      - migration-immutability\n"))).toEqual(["ci_job_changed"]);
    expect(reasons(base.replace(/ {2}migration-immutability:[\s\S]*?(?= {2}# next job)/, ""))).toEqual(["ci_job_removed"]);
    expect(reasons(base.replace("runs-on: ubuntu-latest", "runs-on: ubuntu-24.04"))).toEqual([]);
  });

  it("finds the drafted CI job surface in report mode", () => {
    const surface = checkerWorkflowSurface(readFileSync(ciPath, "utf8"));
    expect(surface.job).toMatch(/^ {2}migration-immutability:\n/);
    expect(surface.job).toContain("continue-on-error: true");
    expect(surface.job).toContain(`git show "HEAD^1:$file"`);
    expect(surface.job).not.toContain("--enforce");
    expect(surface.mentions).toEqual([]);
  });

  it("detects an edited or removed portable-node wrapper", () => {
    const reasons = (dir) => check(dir).report.gate_loosening.reasons.map((r) => r.kind);
    expect(reasons(overlayRepo({ [NODE_TEST_PATH]: "// base\n" }, { [NODE_TEST_PATH]: "// relaxed\n" }))).toEqual(["checker_changed"]);
    expect(reasons(overlayRepo({ [NODE_TEST_PATH]: "// base\n" }, { [NODE_TEST_PATH]: null }))).toEqual(["checker_removed"]);
  });
});

describe("CI step runs the base copy of the checker", () => {
  /** The `run: |` body of the "Check migration immutability" step, dedented. */
  function stepScript() {
    const lines = readFileSync(ciPath, "utf8").split("\n");
    const name = lines.findIndex((line) => line.trim() === "- name: Check migration immutability");
    const runLine = lines.findIndex((line, i) => i > name && line.trim() === "run: |");
    const body = [];
    for (let i = runLine + 1; i < lines.length && (lines[i].trim() === "" || lines[i].search(/\S/) > lines[runLine].search(/\S/)); i += 1) body.push(lines[i]);
    const indent = body[0].search(/\S/);
    return body.map((line) => line.slice(indent)).join("\n");
  }

  function runStep(dir, env = {}) {
    const runnerTemp = mkdtempSync(join(tmpdir(), "migration-immutability-runner-"));
    temps.push(runnerTemp);
    const summary = join(runnerTemp, "summary.md");
    const result = spawnSync("bash", ["-c", stepScript()], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: runnerTemp, GITHUB_STEP_SUMMARY: summary, GITHUB_EVENT_NAME: "push", ...env },
    });
    return { ...result, summary: readFileSync(summary, "utf8"), report: JSON.parse(readFileSync(join(runnerTemp, "migration-immutability.json"), "utf8")) };
  }

  const realChecker = readFileSync(join(repoRoot, CHECKER_PATH), "utf8");
  const skipper = 'console.log("HEAD COPY: all clear");\n';

  it("a PR that edits the checker still runs the base copy", () => {
    const dir = overlayRepo({ [CHECKER_PATH]: realChecker }, { [CHECKER_PATH]: skipper, [OLD]: "-- edited\n" });
    const { status, stdout, summary, report } = runStep(dir);
    expect(status).toBe(0);
    expect(stdout).toContain("Checker taken from: base");
    expect(stdout).not.toContain("HEAD COPY");
    expect(stdout).toContain(`FAIL ${OLD} is modified.`);
    expect(report.gate_loosening.reasons).toEqual([expect.objectContaining({ kind: "checker_changed", path: CHECKER_PATH })]);
    expect(summary).toContain("**GATE LOOSENING: needs Grok Bot countersign + Blaine's card.**");
  });

  it("falls back to the head copy when the base has none", () => {
    const { stdout } = runStep(overlayRepo({}, { [CHECKER_PATH]: realChecker, [LATER]: "select 1;\n" }));
    expect(stdout).toContain("Checker taken from: head");
    expect(stdout).toContain("OK: supabase/migrations only gains new, later files.");
  });

  it("on pull_request feeds the timeline from gh to the base checker and voids a stale label", () => {
    const dir = overlayRepo({ [CHECKER_PATH]: realChecker }, { [OLD]: "-- edited\n" });
    const bin = mkdtempSync(join(tmpdir(), "migration-immutability-bin-"));
    temps.push(bin);
    const events = join(bin, "events.ndjson");
    writeFileSync(events, `${JSON.stringify({ event: "labeled", created_at: "2026-10-10T07:00:00Z", actor: { login: "optomachina" }, label: { name: OVERRIDE_LABEL } })}\n`);
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$@" > "${join(bin, "args")}"\ncat "${events}"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "optomachina/Overdrafter", PR_NUMBER: "871", PR_HEAD_SHA: "b".repeat(40), PR_HEAD_PUSHED_AT: "2026-10-10T08:00:00Z" };
    const stale = runStep(dir, env);
    expect(readFileSync(join(bin, "args"), "utf8")).toContain("repos/optomachina/Overdrafter/issues/871/timeline");
    expect(stale.report).toMatchObject({ ok: false, override: { status: "ignored", headSha: "b".repeat(40) } });
    writeFileSync(events, `${JSON.stringify({ event: "labeled", created_at: "2026-10-10T09:00:00Z", actor: { login: "optomachina" }, label: { name: OVERRIDE_LABEL } })}\n`);
    expect(runStep(dir, env).report).toMatchObject({ ok: true, waived: true, override: { status: "approved" } });
  });
});

describe("invoked directly through a symlink", () => {
  // Node resolves symlinks in import.meta.url but not in process.argv[1]. On
  // macOS the temp dir (/var/folders) is itself a symlink, so a checker copied
  // there used to print nothing and exit 0 (silent fail-open).
  const realChecker = readFileSync(join(repoRoot, CHECKER_PATH), "utf8");

  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "migration-immutability-link-"));
    temps.push(dir);
    return dir;
  }

  function runChecker(checkerPath, root, extra = []) {
    return spawnSync(process.execPath, [checkerPath, "--root", root, "--base-ref", "HEAD^1", "--head-ref", "HEAD", ...extra], { encoding: "utf8" });
  }

  it("runs and reports when the checker's directory is reached through a symlink", () => {
    const realDir = join(scratch(), "real");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "check-migration-immutability.mjs"), realChecker);
    const linkDir = join(scratch(), "link");
    symlinkSync(realDir, linkDir, "dir");
    const violating = overlayRepo({}, { [OLD]: "-- edited\n" });
    const clean = overlayRepo({}, { [LATER]: "select 1;\n" });

    const direct = runChecker(join(realDir, "check-migration-immutability.mjs"), violating, ["--enforce"]);
    const viaLink = runChecker(join(linkDir, "check-migration-immutability.mjs"), violating, ["--enforce"]);
    expect(viaLink.stderr).toBe("");
    expect(viaLink.stdout).toMatch(/^Migration immutability: /);
    expect(viaLink.stdout).toContain(`FAIL ${OLD} is modified.`);
    expect(viaLink.status).toBe(1);
    expect(viaLink.stdout).toBe(direct.stdout);
    expect(viaLink.status).toBe(direct.status);

    const ok = runChecker(join(linkDir, "check-migration-immutability.mjs"), clean, ["--enforce"]);
    expect(ok.stdout).toMatch(/^Migration immutability: /);
    expect(ok.status).toBe(0);
  });

  it("runs and reports when the checker file itself is a symlink", () => {
    const realDir = scratch();
    writeFileSync(join(realDir, "check-migration-immutability.mjs"), realChecker);
    const linkFile = join(scratch(), "checker-link.mjs");
    symlinkSync(join(realDir, "check-migration-immutability.mjs"), linkFile, "file");
    const result = runChecker(linkFile, overlayRepo({}, { [OLD]: "-- edited\n" }), ["--enforce"]);
    expect(result.stdout).toContain(`FAIL ${OLD} is modified.`);
    expect(result.status).toBe(1);
  });

  it("is still inert when imported rather than run", () => {
    const dir = scratch();
    writeFileSync(join(dir, "check-migration-immutability.mjs"), realChecker);
    const importer = join(dir, "importer.mjs");
    writeFileSync(importer, 'import { MIGRATIONS_DIR } from "./check-migration-immutability.mjs";\nconsole.log(MIGRATIONS_DIR);\n');
    const result = spawnSync(process.execPath, [importer], { encoding: "utf8" });
    expect(result.stdout).toBe("supabase/migrations\n");
    expect(result.status).toBe(0);
  });
});

describe("parsers and fixtures", () => {
  it("parses raw -z diff entries with one and two paths", () => {
    const raw = [":100644 100644 aaa bbb M", "supabase/migrations/1.sql", ":100644 100644 ccc ccc R100", "supabase/migrations/2.sql", "supabase/migrations/3.sql", ""].join("\0");
    expect(parseRawDiff(raw)).toEqual([
      { status: "M", score: null, oldMode: "100644", newMode: "100644", oldBlob: "aaa", newBlob: "bbb", path: "supabase/migrations/1.sql" },
      { status: "R", score: 100, oldMode: "100644", newMode: "100644", oldBlob: "ccc", newBlob: "ccc", oldPath: "supabase/migrations/2.sql", path: "supabase/migrations/3.sql" },
    ]);
  });

  it("parses timeline arrays, pages of arrays and NDJSON", () => {
    const event = { event: "labeled" };
    expect(parseTimeline(JSON.stringify([event]))).toEqual([event]);
    expect(parseTimeline(JSON.stringify([[event], [event]]))).toEqual([event, event]);
    expect(parseTimeline(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`)).toEqual([event, event]);
    expect(parseTimeline("")).toEqual([]);
  });

  it("rejects bad arguments with exit 2", () => {
    expect(runCli(["--bogus"]).code).toBe(2);
    expect(runCli(["--base-ref", "HEAD^1"]).code).toBe(2);
  });

  it("the real migration history is all timestamped, so the backdating rule applies to it", () => {
    const names = readdirSync(join(repoRoot, "supabase/migrations"));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !/^\d{14}_[^/]+\.sql$/.test(name))).toEqual([]);
  });

  it("fixtures live outside supabase/ and no fixture path contains supabase/migrations/", () => {
    expect(relative(repoRoot, fixtures).split("/")[0]).toBe("scripts");
    const paths = execFileSync("git", ["ls-files", "--others", "--cached", "--exclude-standard", "--", relative(repoRoot, fixtures)], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => /supabase\/+migrations(\/|$)/i.test(path))).toEqual([]);
  });
});
