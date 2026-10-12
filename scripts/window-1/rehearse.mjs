#!/usr/bin/env node
/**
 * OVD-635 migration window 1 rehearsal. Disposable and local only.
 *
 * Builds a throwaway PostgreSQL cluster that listens on a private Unix socket
 * and on no TCP address (listen_addresses = ''), so no step can reach a
 * network host. Then:
 *   1. applies the Supabase platform shim and every migration of the pinned
 *      main commit, pins or checks the OVD-602 inventory, runs main's pgTAP
 *      suites as a baseline;
 *   2. applies each window 1 draft in manifest order (bytes read from the
 *      pinned PR commit with git, sha256 recorded), diffing the inventory after
 *      each one;
 *   3. runs each draft's pgTAP suite and main's suites again (regressions);
 *   4. diffs the inventory against the pin and the expected window 1 diff;
 *   5. rolls back in reverse order, checking each step returns to the
 *      inventory from before that migration (minus declared residuals);
 *   6. re-applies everything, checks the inventory equals the first apply,
 *      and reruns the draft suites.
 * Every psql child gets a scrubbed environment pointing at the socket.
 *
 *   node scripts/window-1/rehearse.mjs [--out <dir>]   (default: a scratch dir under the OS temp dir)
 *       [--write-pin] [--write-expected] [--skip-main-suites] [--keep]
 *       [--order ovd-462,ovd-723,ovd-722]   (default: manifest recommendedOrder; a subset is allowed)
 *
 * Exit 0 only when every gate passes. Never connects to a hosted database.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, chownSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { byCodeUnit, diffInventories, formatInventory, isEmptyDiff, parseInventory, renderDiff } from "./ovd602-diff.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = "docs/release/window-1/manifest.json";
const SHIM = "scripts/window-1/supabase-shim.sql";
const INVENTORY_SQL = "scripts/window-1/ovd602-inventory.sql";
const SUITE_TIMEOUT_MS = 240_000;
const RUN_LIMIT_MS = 30 * 60_000;
// Absolute tool paths (no PATH lookup), as in scripts/migration-timestamp.mjs.
const BIN = { git: "/usr/bin/git", tar: "/usr/bin/tar", id: "/usr/bin/id", chmod: "/usr/bin/chmod", runuser: "/usr/sbin/runuser" };
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// ------------------------------------------------------------------ helpers
export function parsePgTap(output) {
  const plan = /^\s*1\.\.(\d+)\s*$/m.exec(output);
  const ok = (output.match(/^\s*ok \d+/gm) ?? []).length;
  const notOkLines = output.match(/^\s*not ok \d+.*$/gm) ?? [];
  return { planned: plan ? Number(plan[1]) : null, ok, notOk: notOkLines.length, failures: notOkLines.map((l) => l.trim()) };
}

export function suitePassed(result) {
  return result.rc === 0 && result.planned !== null && result.planned === result.ok && result.notOk === 0;
}

/** Lines [0, end) where end is the line matching `pattern`, minus an "-- ====" banner right before it. */
export function sliceBeforeMarker(lines, pattern, trimBanner = true) {
  const re = new RegExp(pattern);
  let end = lines.findIndex((l) => re.test(l));
  if (end < 0) throw new Error(`marker ${pattern} not found`);
  if (trimBanner && /^-- =+$/.test(lines[end - 1] ?? "")) end -= 1;
  return lines.slice(0, end);
}

export function extractDraft(text, spec) {
  if (!spec.endBeforeLineMatching && !spec.startAtBannerBefore) return text;
  let lines = text.split("\n");
  let start = 0;
  if (spec.startAtBannerBefore) {
    const re = new RegExp(spec.startAtBannerBefore);
    start = lines.findIndex((l) => re.test(l));
    if (start < 0) throw new Error(`marker ${spec.startAtBannerBefore} not found`);
    if (/^-- =+$/.test(lines[start - 1] ?? "")) start -= 1;
  }
  if (spec.endBeforeLineMatching) {
    const tail = sliceBeforeMarker(lines.slice(start), spec.endBeforeLineMatching, true);
    lines = tail;
  } else {
    lines = lines.slice(start);
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** The runnable body of a commented rollback section: "-- " stripped, nothing else changed. */
export function uncommentSection(text, start, end) {
  const lines = text.split("\n");
  const s = lines.indexOf(start);
  const e = lines.indexOf(end, s + 1);
  if (s < 0 || e < 0) throw new Error(`rollback section ${start} .. ${end} not found`);
  return `${lines.slice(s, e + 1).map((l) => l.replace(/^-- ?/, "")).join("\n")}\n`;
}

export function packetBody(text) {
  const marker = "-- ---- body (derived, do not edit) ----\n";
  const at = text.indexOf(marker);
  if (at < 0) throw new Error("packet rollback has no body marker");
  return text.slice(at + marker.length);
}

/** The ```sql readback blocks of each "## Migration N: OVD-xxx" section of the run sheet, by migration id. */
export function readmeReadbacks(text) {
  const out = {};
  const sections = text.split(/^## /m);
  for (const sec of sections) {
    const m = /^Migration \d+: OVD-(\d+)/.exec(sec);
    if (!m) continue;
    out[`ovd-${m[1]}`] = [...sec.matchAll(/```sql\n([\s\S]*?)```/g)].map((x) => x[1]);
  }
  return out;
}

/** Files with CONCURRENTLY or their own BEGIN/COMMIT cannot run inside psql --single-transaction. */
export function needsOwnTransaction(sql) {
  return /\bconcurrently\b/i.test(sql) || /^\s*(begin|commit)\s*;/im.test(sql);
}

function residualKeys(diff) {
  const keys = [];
  const id = { relations: (e) => e.name, policies: (e) => `${e.table} ${e.name}`, functions: (e) => e.signature, schemas: (e) => e.name };
  for (const [section, entries] of Object.entries(diff.removed)) for (const e of entries) keys.push(`${section}:${id[section](e)}`);
  for (const [section, entries] of Object.entries(diff.added)) for (const e of entries) keys.push(`+${section}:${id[section](e)}`);
  for (const [section, entries] of Object.entries(diff.changed)) for (const e of entries) keys.push(`~${section}:${e.key}`);
  return keys.sort(byCodeUnit);
}

// ------------------------------------------------------------------ runner
class Rehearsal {
  constructor(options) {
    this.options = options;
    this.started = Date.now();
    this.steps = [];
    this.gates = [];
    this.manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
    const order = options.order ?? this.manifest.recommendedOrder?.join(",");
    if (order) {
      const byId = new Map(this.manifest.migrations.map((x) => [x.id, x]));
      const ids = order.split(",");
      if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
        throw new Error(`--order takes distinct ids from ${[...byId.keys()].join(",")}`);
      }
      this.manifest.migrations = ids.map((id) => byId.get(id));
    }
    this.manifest.order = this.manifest.migrations.map((x) => x.id);
    this.out = resolve(ROOT, options.out);
    this.logs = join(this.out, "evidence"); // "logs" directories are gitignored
  }

  git(args, { encoding = "utf8" } = {}) {
    const r = spawnSync(BIN.git, args, { cwd: ROOT, encoding, maxBuffer: 256_000_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  }

  gate(name, pass, detail = "") {
    this.gates.push({ name, pass: Boolean(pass), detail });
    process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `  (${detail})` : ""}\n`);
  }

  async step(name, fn) {
    if (Date.now() - this.started > RUN_LIMIT_MS) throw new Error("rehearsal exceeded its 30 minute runner limit");
    const t0 = process.hrtime.bigint();
    process.stdout.write(`-- ${name}\n`);
    try {
      const result = await fn();
      this.steps.push({ name, ms: Number((process.hrtime.bigint() - t0) / 1_000_000n), ok: true });
      return result;
    } catch (error) {
      this.steps.push({ name, ms: Number((process.hrtime.bigint() - t0) / 1_000_000n), ok: false, error: error.message });
      throw error;
    }
  }

  // ----- cluster lifecycle (socket only)
  pgBin() {
    if (process.env.OVD_PG_BIN) return process.env.OVD_PG_BIN;
    // Production's major version (manifest postgresMajor); the inventory differs across majors (PG17 adds MAINTAIN).
    const major = String(this.manifest.postgresMajor);
    const dir = join("/usr/lib/postgresql", major, "bin");
    if (!existsSync(dir)) throw new Error(`PostgreSQL ${major} server binaries not found at ${dir}; set OVD_PG_BIN`);
    return dir;
  }

  asOwner(cmd, args) {
    const full = join(this.bin, cmd);
    const r = this.root
      ? spawnSync(BIN.runuser, ["-u", "postgres", "--", full, ...args], { encoding: "utf8", env: this.env, cwd: this.work })
      : spawnSync(full, args, { encoding: "utf8", env: this.env, cwd: this.work });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
    return r.stdout;
  }

  startCluster() {
    this.bin = this.pgBin();
    this.root = userInfo().uid === 0;
    this.work = mkdtempSync(join(tmpdir(), "ovd635-window1-"));
    chmodSync(this.work, 0o755);
    if (this.root) {
      const pg = spawnSync(BIN.id, ["-u", "postgres"], { encoding: "utf8" });
      const pgGid = spawnSync(BIN.id, ["-g", "postgres"], { encoding: "utf8" });
      if (pg.status !== 0) throw new Error("running as root needs a postgres OS user");
      chownSync(this.work, Number(pg.stdout), Number(pgGid.stdout));
    }
    this.socket = this.work;
    this.port = "5432";
    // Scrubbed environment: no inherited connection settings can redirect psql.
    this.env = {
      PATH: process.env.PATH, HOME: this.work, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      PGHOST: this.socket, PGPORT: this.port, PGUSER: "postgres", PGDATABASE: "rehearsal", PGCONNECT_TIMEOUT: "10",
    };
    const data = join(this.work, "data");
    this.asOwner("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-sync", "--locale=C.UTF-8"]);
    this.asOwner("pg_ctl", ["-D", data, "-l", join(this.work, "server.log"), "-w", "-o",
      `-c listen_addresses='' -c unix_socket_directories=${this.socket} -c port=${this.port} -c fsync=off -c max_connections=60 -c shared_buffers=128MB`,
      "start"]);
    this.data = data;
    this.psql(["-d", "postgres", "-c", "create database rehearsal"]);
    const listen = this.psql(["-At", "-c", "show listen_addresses"]).stdout.trim();
    if (listen !== "") throw new Error(`cluster must not listen on TCP, got listen_addresses=${listen}`);
    const version = this.psql(["-At", "-c", "show server_version"]).stdout.trim();
    const major = Number(this.psql(["-At", "-c", "show server_version_num"]).stdout.trim().slice(0, -4));
    if (major !== this.manifest.postgresMajor) {
      throw new Error(`rehearsal cluster is PostgreSQL ${major}; production (manifest postgresMajor) is ${this.manifest.postgresMajor}`);
    }
    return { work: this.work, version, listen_addresses: "(none, Unix socket only)" };
  }

  stopCluster() {
    if (!this.data) return;
    try { this.asOwner("pg_ctl", ["-D", this.data, "-m", "fast", "-w", "stop"]); } catch { /* already stopped */ }
    if (!this.options.keep) rmSync(this.work, { recursive: true, force: true });
    this.cleaned = !existsSync(this.work);
  }

  psql(args, { input, db, check = true, timeout = SUITE_TIMEOUT_MS, cwd } = {}) {
    const full = ["-X", "-v", "ON_ERROR_STOP=1", ...(db ? ["-d", db] : []), ...args];
    const t0 = process.hrtime.bigint();
    const r = spawnSync(join(this.bin, "psql"), full, {
      encoding: "utf8", env: this.env, input, timeout, maxBuffer: 256_000_000, cwd: cwd ?? this.work,
    });
    const result = { rc: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms: Number((process.hrtime.bigint() - t0) / 1_000_000n), timedOut: Boolean(r.error) };
    if (check && result.rc !== 0) throw new Error(`psql ${args.join(" ")} failed (${result.rc}): ${result.stderr.slice(-2000)}`);
    return result;
  }

  applyFile(path, { db = "rehearsal", single } = {}) {
    const sql = readFileSync(path, "utf8");
    const one = single ?? !needsOwnTransaction(sql);
    return this.psql([...(one ? ["--single-transaction"] : []), "-q", "-f", path], { db, check: false });
  }

  inventory(db = "rehearsal") {
    const r = this.psql(["-A", "-t", "-q", "-f", join(ROOT, INVENTORY_SQL)], { db });
    return parseInventory(r.stdout.trim(), `inventory(${db})`);
  }

  log(name, text) {
    writeFileSync(join(this.logs, name), text);
    return relative(ROOT, join(this.logs, name));
  }

  // ----- source materialization (git objects only, no network)
  materializeTree(sha, paths, label) {
    const dir = join(this.work, `src-${label}`);
    mkdirSync(dir, { recursive: true });
    const tar = spawnSync(BIN.git, ["archive", "--format=tar", sha, ...paths], { cwd: ROOT, maxBuffer: 512_000_000 });
    if (tar.status !== 0) throw new Error(`git archive ${sha} failed: ${tar.stderr}`);
    const x = spawnSync(BIN.tar, ["-x", "-C", dir], { input: tar.stdout });
    if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
    if (this.root) spawnSync(BIN.chmod, ["-R", "a+rX", dir]);
    return dir;
  }

  writeWork(name, text) {
    const path = join(this.work, name);
    writeFileSync(path, text);
    chmodSync(path, 0o644);
    return path;
  }

  // ----- pgTAP
  cloneDb(name) {
    this.psql(["-d", "postgres", "-c", `create database ${name} template rehearsal`]);
    // Like `supabase test db`, pgTAP is installed before the suite runs.
    this.psql(["-q", "-c", "create extension if not exists pgtap with schema extensions"], { db: name });
    // Database level settings are not copied by CREATE DATABASE ... TEMPLATE.
    this.psql(["-d", "postgres", "-c", `alter database ${name} set search_path = "$user", public, extensions`]);
    this.psql(["-d", "postgres", "-c",
      `alter database ${name} set ovd.test_conninfo = 'host=${this.socket} port=${this.port} dbname=${name} user=postgres'`]);
  }

  dropDb(name) {
    this.psql(["-d", "postgres", "-c", `drop database if exists ${name} with (force)`]);
  }

  runSuite(file, label, { prelude } = {}) {
    const db = `t_${label}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
    this.cloneDb(db);
    try {
      if (prelude) {
        const p = this.applyFile(prelude, { db, single: true });
        if (p.rc !== 0) return { rc: p.rc, planned: null, ok: 0, notOk: 0, failures: [], error: `prelude failed: ${p.stderr.slice(-800)}`, ms: p.ms };
      }
      const r = this.psql(["-q", "-f", file], { db, check: false, cwd: dirname(file) });
      const tap = parsePgTap(r.stdout);
      const error = (r.stderr.match(/^psql:.*ERROR:.*$/m) ?? [""])[0];
      return { rc: r.rc, ...tap, error, ms: r.ms, timedOut: r.timedOut, output: r.stdout + r.stderr };
    } finally {
      this.dropDb(db);
    }
  }

  runSuites(dir, files, tag) {
    const results = {};
    for (const f of files) {
      const r = this.runSuite(join(dir, f), `${tag}_${f.replace(/\.sql(\.pending)?$/, "")}`);
      // Passing main suites keep only their counts; failing ones keep the full TAP.
      if (!suitePassed(r)) r.log = this.log(`${tag}--${f.replace(/\//g, "_")}.tap`, r.output ?? r.error ?? "");
      delete r.output;
      results[f] = r;
      process.stdout.write(`   ${suitePassed(r) ? "ok  " : "FAIL"} ${f} plan=${r.planned} ok=${r.ok} notok=${r.notOk} ${r.ms}ms${r.error ? ` ${r.error}` : ""}\n`);
    }
    return results;
  }

  /**
   * Rollback guard under a concurrent writer: session A commits an occupant
   * while the rollback (session B) is already running. B must wait for A and
   * then refuse, leaving every object in place.
   */
  async rollbackRace(mig, rollbackPath) {
    const race = mig.rollbackRace;
    const db = `race_${mig.id.replace(/[^a-z0-9]/g, "_")}`;
    this.cloneDb(db);
    try {
      const writer = spawn(join(this.bin, "psql"), ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db], { env: this.env, cwd: this.work });
      let writerOut = "";
      writer.stdout.on("data", (d) => { writerOut += d; });
      writer.stderr.on("data", (d) => { writerOut += d; });
      const writerDone = new Promise((done) => writer.on("close", (code) => done(code)));
      writer.stdin.end(`begin;\n${race.writerSql}\nselect pg_sleep(${race.holdSeconds});\ncommit;\n`);
      const deadline = Date.now() + 10_000;
      let holding = false;
      while (!holding && Date.now() < deadline) {
        const q = this.psql(["-At", "-c", `select count(*) from pg_locks l join pg_stat_activity a using (pid)
          where l.relation = '${race.table}'::regclass and l.granted and a.datname = '${db}' and a.state = 'active'`], { db });
        holding = Number(q.stdout.trim()) > 0;
        if (!holding) await new Promise((r) => setTimeout(r, 100));
      }
      if (!holding) throw new Error("writer never took its lock");
      const rb = this.psql(["--single-transaction", "-q", "-f", rollbackPath], { db, check: false });
      const writerCode = await writerDone;
      const left = this.psql(["-At", "-c", race.verifySql], { db }).stdout.trim();
      return { writerCode, writerOut: writerOut.slice(-500), rollbackRc: rb.rc, rollbackMs: rb.ms,
        rollbackError: (rb.stderr.match(/ERROR:.*$/m) ?? [""])[0], verify: left };
    } finally {
      this.dropDb(db);
    }
  }

  // ----- the rehearsal
  async run() {
    const m = this.manifest;
    assertReplaceableOut(this.out);
    rmSync(this.out, { recursive: true, force: true });
    mkdirSync(this.logs, { recursive: true });
    const summary = { format: "ovd635.rehearsal.v1", base: m.base, order: m.order, startedAt: new Date().toISOString(), migrations: [] };

    // Pinned identities must exist locally; nothing is fetched.
    for (const sha of [m.base.sha, ...m.migrations.map((x) => x.sha)]) this.git(["cat-file", "-e", `${sha}^{commit}`]);
    summary.packetSourceHead = this.git(["rev-parse", "HEAD"]).trim();

    summary.cluster = await this.step("cluster: initdb and start (socket only)", () => this.startCluster());
    try {
      const mainSrc = this.materializeTree(m.base.sha, ["supabase/migrations", "supabase/tests"], "main");
      await this.step("platform shim", () => {
        const r = this.applyFile(join(ROOT, SHIM), { single: true });
        if (r.rc !== 0) throw new Error(r.stderr);
        this.psql(["-c", 'alter database rehearsal set search_path = "$user", public, extensions']);
      });

      const migrationsDir = join(mainSrc, "supabase/migrations");
      const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort(byCodeUnit);
      summary.mainMigrations = await this.step(`main migrations (${migrations.length})`, () => {
        const timings = [];
        for (const f of migrations) {
          const r = this.applyFile(join(migrationsDir, f));
          timings.push({ file: f, ms: r.ms, rc: r.rc });
          if (r.rc !== 0) throw new Error(`${f}: ${r.stderr.slice(-1500)}`);
        }
        return { count: migrations.length, totalMs: timings.reduce((a, t) => a + t.ms, 0), slowest: [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5) };
      });
      this.gate("main migrations apply on the disposable cluster", true, `${migrations.length} files`);

      // OVD-602 baseline and pin.
      const baseline = await this.step("ovd602: inventory of main", () => this.inventory());
      const pinPath = join(ROOT, m.pin);
      if (this.options.writePin) writeFileSync(pinPath, formatInventory(baseline));
      const pin = parseInventory(readFileSync(pinPath, "utf8"), m.pin);
      const pinDiff = diffInventories(pin, baseline);
      this.log("ovd602-main-vs-pin.txt", renderDiff(pinDiff));
      this.gate("ovd602: main inventory equals the checked in pin", isEmptyDiff(pinDiff));
      summary.inventory = {
        definerFunctions: baseline.functions.filter((f) => f.definer).length,
        definerWithoutSearchPath: baseline.functions.filter((f) => f.definer && !f.search_path).length,
        definerExecutableByAnon: baseline.functions.filter((f) => f.definer && f.execute.includes("anon")).length,
        definerExecutableByPublic: baseline.functions.filter((f) => f.definer && f.execute.includes("PUBLIC")).length,
        relations: baseline.relations.length, policies: baseline.policies.length,
      };

      const testsDir = join(mainSrc, "supabase/tests");
      const mainSuites = readdirSync(testsDir).filter((f) => f.endsWith(".sql")).sort(byCodeUnit);
      if (!this.options.skipMainSuites) {
        summary.mainSuitesBaseline = await this.step(`pgTAP: main suites on main (${mainSuites.length})`, () => this.runSuites(testsDir, mainSuites, "main"));
      }

      // Materialize window sources.
      const sources = {};
      for (const mig of m.migrations) {
        const draftText = this.git(["show", `${mig.sha}:${mig.draft.path}`]);
        const forward = extractDraft(draftText, mig.draft);
        const forwardPath = this.writeWork(`${mig.id}.forward.sql`, forward);
        let rollbackText;
        if (mig.rollback.packet) {
          rollbackText = readFileSync(join(ROOT, mig.rollback.packet), "utf8");
          if (mig.rollback.derivedFromDraft) {
            const derived = uncommentSection(draftText, mig.rollback.derivedFromDraft.start, mig.rollback.derivedFromDraft.end);
            this.gate(`${mig.id}: packet rollback body equals the draft's commented rollback`, packetBody(rollbackText) === derived);
          }
        } else {
          rollbackText = this.git(["show", `${mig.rollback.sha}:${mig.rollback.path}`]);
        }
        const rollbackPath = this.writeWork(`${mig.id}.rollback.sql`, rollbackText);
        const phase2Path = mig.phase2 ? this.writeWork(`${mig.id}.phase2.sql`, extractDraft(draftText, mig.phase2)) : null;
        const tests = this.materializeTree(mig.sha, ["supabase/tests"], mig.id);
        sources[mig.id] = { forwardPath, rollbackPath, phase2Path, tests: join(tests, "supabase/tests") };
        summary.migrations.push({
          id: mig.id, pr: mig.pr, sha: mig.sha, slug: mig.slug, draft: mig.draft.path,
          forwardSha256: sha256(forward), forwardBytes: Buffer.byteLength(forward), forwardLines: forward.split("\n").length - 1,
          draftSha256: sha256(draftText), rollbackSha256: sha256(rollbackText),
          rollbackSource: mig.rollback.packet ?? `${mig.rollback.path}@${mig.rollback.sha.slice(0, 8)}`,
          ownTransaction: needsOwnTransaction(forward),
          rounds: [],
        });
      }
      const rec = (id) => summary.migrations.find((x) => x.id === id);

      // Main suites a PR edits land together with its migration, so after a
      // migration is applied the main suites run with that PR's versions.
      const changedSuites = {};
      for (const mig of m.migrations) {
        changedSuites[mig.id] = this.git(["diff", "--name-only", `${m.base.sha}...${mig.sha}`, "--", "supabase/tests"])
          .split("\n").filter((f) => /^supabase\/tests\/[^/]+\.sql$/.test(f)).map((f) => f.slice("supabase/tests/".length));
        rec(mig.id).mainSuitesEditedByPr = changedSuites[mig.id];
      }
      const overlayFor = (applied) => {
        const dir = join(this.work, `suites-${applied.map((x) => x.id).join("+")}`);
        cpSync(testsDir, dir, { recursive: true });
        for (const mig of applied) {
          for (const f of changedSuites[mig.id]) cpSync(join(sources[mig.id].tests, f), join(dir, f));
        }
        return dir;
      };

      // Apply, test, roll back, re-apply.
      const runDraftSuites = async (round, migs = m.migrations, onlyPhase = null) => {
        for (const mig of migs) {
          for (const suite of mig.suites.filter((x) => !onlyPhase || x.phase === onlyPhase)) {
            const prelude = suite.phase === "phase2-informational" ? sources[mig.id].phase2Path : undefined;
            const r = await this.step(`${round}: pgTAP ${mig.id} ${suite.path} [${suite.phase}]`, () =>
              this.runSuite(join(sources[mig.id].tests, relative("supabase/tests", suite.path)), `${round}_${mig.id}_${suite.phase}`, { prelude }));
            this.log(`${round}--${mig.id}--${suite.phase}.tap`, r.output ?? r.error ?? "");
            delete r.output;
            rec(mig.id).rounds.at(-1)[`pgtap_${round}_${suite.phase}`] = r;
            const gateName = `${round}: ${mig.id} pgTAP ${suite.phase}`;
            if (suite.phase === "window") this.gate(gateName, suitePassed(r), `${r.ok}/${r.planned} ok, ${r.notOk} not ok${r.error ? `, ${r.error}` : ""}`);
            else process.stdout.write(`INFO ${gateName}: ${r.ok}/${r.planned} ok, ${r.notOk} not ok\n`);
          }
        }
      };

      const applyAll = async (round) => {
        const before = {};
        for (const mig of m.migrations) {
          before[mig.id] = this.inventory();
          const r = await this.step(`${round}: apply ${mig.id}`, () => this.applyFile(sources[mig.id].forwardPath));
          const logPath = this.log(`${round}--${mig.id}--apply.txt`, `${r.stdout}${r.stderr}`);
          const warnings = (r.stderr.match(/^.*(WARNING|ERROR):.*$/gm) ?? []);
          const after = this.inventory();
          const stepDiff = diffInventories(before[mig.id], after);
          this.log(`${round}--${mig.id}--ovd602.txt`, renderDiff(stepDiff));
          rec(mig.id).rounds.push({ round, apply: { rc: r.rc, ms: r.ms, log: logPath, warnings }, ovd602Flags: stepDiff.flags });
          this.gate(`${round}: ${mig.id} applies`, r.rc === 0, `${r.ms} ms${warnings.length ? `, ${warnings.length} warnings` : ""}`);
          if (r.rc !== 0) throw new Error(`${mig.id} failed to apply: ${r.stderr.slice(-2000)}`);
          await runDraftSuites(`${round}-own`, [mig], "window");
          if (round === "apply" && !this.options.skipMainSuites) {
            const applied = m.migrations.slice(0, m.migrations.indexOf(mig) + 1);
            const suitesDir = overlayFor(applied);
            const after = await this.step(`pgTAP: main suites after ${mig.id}`, () => this.runSuites(suitesDir, mainSuites, `after-${mig.id}`));
            const regressed = mainSuites.filter((f) => suitePassed(summary.mainSuitesBaseline[f]) && !suitePassed(after[f]));
            rec(mig.id).mainSuiteRegressionsCumulative = regressed;
            // Per step gate: a suite that passed before this migration and fails after it.
            const before = summary.mainSuitesBeforeStep ?? summary.mainSuitesBaseline;
            const stepRegressed = mainSuites.filter((f) => suitePassed(before[f]) && !suitePassed(after[f]));
            rec(mig.id).mainSuiteRegressionsThisStep = stepRegressed;
            this.gate(`main pgTAP suites: no regression caused by ${mig.id}`, stepRegressed.length === 0, stepRegressed.join(", "));
            summary.mainSuitesBeforeStep = after;
            process.stdout.write(`INFO main suites regressed after ${mig.id} (cumulative): ${regressed.join(", ") || "none"}\n`);
            summary.mainSuitesAfterWindow = after;
          }
        }
        return before;
      };

      const preWindow = await applyAll("apply");
      delete summary.mainSuitesBeforeStep;
      const applied = this.inventory();
      await runDraftSuites("apply-composed");
      if (!this.options.skipMainSuites) {
        const regressions = mainSuites.filter((f) => suitePassed(summary.mainSuitesBaseline[f]) && !suitePassed(summary.mainSuitesAfterWindow[f]));
        summary.mainSuiteRegressions = regressions;
        this.gate("main pgTAP suites: no regression after window 1", regressions.length === 0, regressions.join(", "));
      }

      // Every readback query Blaine runs must return only true on the rehearsed database.
      const readbacks = readmeReadbacks(readFileSync(join(ROOT, "docs/release/window-1/README.md"), "utf8"));
      for (const mig of m.migrations) {
        const blocks = readbacks[mig.id] ?? [];
        const values = [];
        for (const sql of blocks) {
          const r = this.psql(["-A", "-t", "-F", ",", "-c", sql], { check: false });
          values.push(...(r.rc === 0 ? r.stdout.trim().split(/[\n,]/) : [`error: ${r.stderr.trim()}`]));
        }
        rec(mig.id).readback = values;
        this.gate(`${mig.id}: README readback queries return only true`, blocks.length > 0 && values.length > 0 && values.every((v) => v === "t"),
          values.join(" "));
      }
      const windowDiff = diffInventories(pin, applied);
      this.log("ovd602-window1-vs-pin.txt", renderDiff(windowDiff));
      // The expected diff depends on which drafts are applied and in what order.
      const expectedPath = join(ROOT, m.expectedDiffDir, `${m.order.join("+")}.json`);
      summary.expectedDiff = relative(ROOT, expectedPath);
      if (this.options.writeExpected) mkdirSync(dirname(expectedPath), { recursive: true });
      if (this.options.writeExpected) writeFileSync(expectedPath, `${JSON.stringify(windowDiff, null, 2)}\n`);
      const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : null;
      this.gate("ovd602: window 1 diff equals the checked in expected diff",
        expected && JSON.stringify(expected) === JSON.stringify(windowDiff));
      summary.ovd602 = { flags: windowDiff.flags, added: Object.fromEntries(Object.entries(windowDiff.added).map(([k, v]) => [k, v.length])),
        changed: Object.fromEntries(Object.entries(windowDiff.changed).map(([k, v]) => [k, v.length])),
        removed: Object.fromEntries(Object.entries(windowDiff.removed).map(([k, v]) => [k, v.length])) };

      for (const mig of m.migrations.filter((x) => x.rollbackRace)) {
        const r = await this.step(`rollback guard race ${mig.id}`, () => this.rollbackRace(mig, sources[mig.id].rollbackPath));
        rec(mig.id).rollbackRace = r;
        this.log(`rollback-race--${mig.id}.json`, `${JSON.stringify(r, null, 2)}\n`);
        const race = mig.rollbackRace;
        this.gate(`${mig.id}: rollback waits for a concurrent writer and then refuses`,
          r.writerCode === 0 && r.rollbackRc !== 0 && r.rollbackError.includes(race.expectError)
            && r.rollbackMs >= race.holdSeconds * 500 && r.verify === race.expectVerify,
          `rollback ${r.rollbackMs} ms, ${r.rollbackError || "no error"}, verify=${r.verify}`);
      }
      const expectedResidual = [];
      for (const mig of [...m.migrations].reverse()) {
        // Retained objects of every migration rolled back so far show up as additions.
        expectedResidual.push(...mig.rollbackResidual.map((k) => `+${k}`));
        const r = await this.step(`rollback ${mig.id}`, () => this.applyFile(sources[mig.id].rollbackPath, { single: mig.rollback.singleTransaction }));
        const logPath = this.log(`rollback--${mig.id}.txt`, `${r.stdout}${r.stderr}`);
        rec(mig.id).rollback = { rc: r.rc, ms: r.ms, log: logPath };
        this.gate(`rollback ${mig.id} runs`, r.rc === 0, `${r.ms} ms`);
        if (r.rc !== 0) throw new Error(`${mig.id} rollback failed: ${r.stderr.slice(-2000)}`);
        const back = diffInventories(preWindow[mig.id], this.inventory());
        this.log(`rollback--${mig.id}--ovd602.txt`, renderDiff(back));
        const residual = residualKeys(back);
        rec(mig.id).rollback.residual = residual;
        this.gate(`rollback ${mig.id} restores the prior inventory (except declared residuals)`,
          JSON.stringify(residual) === JSON.stringify([...expectedResidual].sort(byCodeUnit)), residual.join(", ") || "none");
      }
      const afterRollback = diffInventories(pin, this.inventory());
      this.log("ovd602-after-rollback-vs-pin.txt", renderDiff(afterRollback));
      summary.afterRollbackResidual = residualKeys(afterRollback);

      await applyAll("reapply");
      const reapplied = this.inventory();
      const reDiff = diffInventories(applied, reapplied);
      this.log("ovd602-reapply-vs-apply.txt", renderDiff(reDiff));
      this.gate("reapply: inventory equals the first apply", isEmptyDiff(reDiff));
      await runDraftSuites("reapply-composed");
    } finally {
      await this.step("cleanup: stop cluster and remove work dir", () => this.stopCluster());
      this.gate("cleanup removed the disposable cluster", this.options.keep || this.cleaned);
      summary.finishedAt = new Date().toISOString();
      summary.totalMs = Date.now() - this.started;
      summary.steps = this.steps;
      summary.gates = this.gates;
      summary.pass = this.gates.every((g) => g.pass);
      writeFileSync(join(this.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    }
    return summary;
  }
}

/** Refuses to wipe a directory that holds anything but a previous run's own output. */
export function assertReplaceableOut(dir) {
  if (!existsSync(dir)) return;
  const extra = readdirSync(dir).filter((f) => !["summary.json", "evidence"].includes(f));
  if (extra.length) throw new Error(`refusing to replace ${dir}: it contains ${extra.join(", ")} (not a rehearsal output directory)`);
}

export function parseArgs(argv) {
  // Default output is a scratch directory; evidence in the repo is written only with an explicit --out.
  const options = { out: join(tmpdir(), "ovd635-rehearsal-out"), writePin: false, writeExpected: false, skipMainSuites: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") options.out = argv[(i += 1)];
    else if (a === "--write-pin") options.writePin = true;
    else if (a === "--write-expected") options.writeExpected = true;
    else if (a === "--skip-main-suites") options.skipMainSuites = true;
    else if (a === "--keep") options.keep = true;
    else if (a === "--order") options.order = argv[(i += 1)];
    else throw new Error(`unknown argument ${a}`);
  }
  return options;
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (direct) {
  const r = new Rehearsal(parseArgs(process.argv.slice(2)));
  r.run().then((s) => {
    process.stdout.write(`\nrehearsal ${s.pass ? "PASS" : "FAIL"} in ${(s.totalMs / 1000).toFixed(1)} s; summary at ${relative(ROOT, join(r.out, "summary.json"))}\n`);
    process.exitCode = s.pass ? 0 : 1;
  }).catch((error) => {
    process.stderr.write(`rehearsal aborted: ${error.message}\n`);
    process.exitCode = 1;
  });
}
