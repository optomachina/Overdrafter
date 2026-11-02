import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROOT, buildPlan, checkOutDir, countCopyRows, createOutDir, describeUrl, main, parseArgs, parseDbUrl, redact,
  resolveSource, resolveSupabase, verifyBackup,
} from "./prod-backup.mjs";

const FAKE_URL = "postgresql://postgres.fakeref:s3cr3t-Pw@pooler.example.invalid:5432/postgres";
const BINS = { supabase: "/opt/fake/bin/supabase", psql: "/opt/fake/bin/psql" };
const bins = () => BINS;
const SCHEMA = 'CREATE TABLE IF NOT EXISTS "public"."jobs" (id uuid);\nCREATE TABLE IF NOT EXISTS "public"."organizations" (id uuid);\n'
  + 'CREATE TABLE IF NOT EXISTS "private"."p" (id uuid);\nCREATE TABLE IF NOT EXISTS "engineering_private"."e" (id uuid);\n';
const DATA = [
  'COPY "public"."jobs" ("id") FROM stdin;', "a", "b", "\\.", "",
  'COPY "auth"."users" ("id") FROM stdin;', "u", "\\.", "",
  'COPY "public"."organizations" ("id") FROM stdin;', "\\.", "",
].join("\n");
const COUNTS = JSON.stringify({ "public.jobs": 2, "auth.users": 1, "public.organizations": 0, "public.payments": null });
const GOOD = { "schema.sql": SCHEMA, "data.sql": DATA, "counts.prod.json": COUNTS, "storage-policies.sql": "create policy x;\n" };

const tmp = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "ovd-backup-test-"));
  tmp.push(d);
  return d;
};
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fakeRunner(files, calls) {
  return (step) => {
    calls.push(step);
    const target = step.cmd === BINS.psql ? step.args[step.args.indexOf("-o") + 1] : step.args[step.args.indexOf("-f") + 1];
    writeFileSync(target, files[basename(target)] ?? "");
    return { status: 0, stderr: "" };
  };
}
const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l), err: (l) => lines.push(l) };
};

describe("prod-backup arguments and credentials", () => {
  it("takes an env var name, never a value", () => {
    expect(parseArgs(["--out", "/x"]).urlEnv).toBe("OVD_BACKUP_DB_URL");
    expect(() => parseArgs(["--out", "/x", "--url-env", FAKE_URL])).toThrow(/NAME/);
    expect(() => parseArgs([])).toThrow(/required/);
    expect(() => parseArgs(["--verify", "/x", "--dry-run"])).toThrow();
    expect(() => parseArgs(["--out"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown/);
  });

  it("describes a URL without host or password", () => {
    expect(describeUrl(FAKE_URL)).not.toMatch(/s3cr3t|pooler\.example|fakeref/);
  });

  it("splits the URL into libpq env and a password-free CLI URL; usage errors for bad input", () => {
    const { pgEnv, cliUrl } = parseDbUrl(FAKE_URL);
    expect(pgEnv).toMatchObject({ PGHOST: "pooler.example.invalid", PGUSER: "postgres.fakeref", PGPASSWORD: "s3cr3t-Pw", PGSSLMODE: "require" });
    expect(cliUrl).toBe("postgresql://postgres.fakeref@pooler.example.invalid:5432/postgres?sslmode=require");
    expect(() => parseDbUrl("https://example.invalid")).toThrow(/postgres/);
    expect(() => parseDbUrl("postgresql://u:%E0%A4%A@h/db")).toThrow(/malformed % escape/);
    expect(() => parseDbUrl("postgresql://u:p@h/db?options=-c")).toThrow(/unsupported query parameters: options/);
    expect(resolveSource({ env: {}, urlEnv: "MY_URL" }).kind).toBe("none");
    expect(main(["--out", join(scratch(), "b"), "--url-env", "U"], { env: { U: "postgresql://u:%zz@h/db" }, bins, ...quiet() })).toBe(2);
  });

  it("runs the reference supabase dump commands and never puts the password in an argument", () => {
    const plan = buildPlan(resolveSource({ env: { U: FAKE_URL }, urlEnv: "U" }), "/tmp/out", BINS);
    expect(plan.map((s) => s.name)).toEqual(["schema", "data", "counts", "storage-policies"]);
    expect(plan.map((s) => s.cmd)).toEqual([BINS.supabase, BINS.supabase, BINS.psql, BINS.psql]);
    const [schema, data] = plan;
    // Same flags as README step 5: no -s/--schema, no pg_dump --no-privileges.
    expect(schema.args.filter((a) => !a.includes("://"))).toEqual(["db", "dump", "--db-url", "-f", "/tmp/out/schema.sql"]);
    expect(data.args.filter((a) => !a.includes("://"))).toEqual(["db", "dump", "--db-url", "--data-only", "--use-copy", "-f", "/tmp/out/data.sql"]);
    expect(schema.env).toEqual({ PGPASSWORD: "s3cr3t-Pw" });
    for (const s of plan) expect(s.args.join(" ")).not.toMatch(/s3cr3t/);
  });

  it("uses an absolute supabase path, never a PATH lookup", () => {
    expect(resolveSupabase({}, (p) => p === "/usr/local/bin/supabase")).toBe("/usr/local/bin/supabase");
    expect(resolveSupabase({ OVD_SUPABASE: "/x/supabase" }, () => true)).toBe("/x/supabase");
    expect(() => resolveSupabase({ OVD_SUPABASE: "supabase" }, () => true)).toThrow(/absolute/);
    expect(() => resolveSupabase({}, () => false)).toThrow(/OVD_SUPABASE/);
  });

  it("redacts the URL, password, host and pooler user", () => {
    const { pgEnv, cliUrl } = parseDbUrl(FAKE_URL);
    const text = `connect ${cliUrl} failed: password authentication failed for user "postgres.fakeref" at pooler.example.invalid (s3cr3t-Pw)`;
    const out = redact(text, [cliUrl, pgEnv.PGPASSWORD, pgEnv.PGHOST, pgEnv.PGUSER]);
    expect(out).not.toMatch(/s3cr3t|pooler\.example|fakeref/);    expect(redact("cannot reach postgresql://x as postgres", ["postgres"])).toBe("cannot reach postgresql://x as postgres");
  });

  it("refuses an output directory inside the repo (also through a symlink) or one that exists", () => {
    expect(() => checkOutDir(join(ROOT, "backup"))).toThrow(/outside the repository/);
    expect(() => checkOutDir(join(ROOT, "..backup"))).toThrow(/outside the repository/);
    expect(() => checkOutDir(scratch())).toThrow(/must not exist/);
    const link = join(scratch(), "repo-link");
    symlinkSync(ROOT, link);
    expect(() => checkOutDir(join(link, "backup", "b"))).toThrow(/outside the repository/);
    const fresh = join(scratch(), "a", "b");
    expect(checkOutDir(fresh)).toBe(fresh);
    createOutDir(fresh);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(() => createOutDir(fresh)).toThrow(/must not exist/);
  });
});

describe("prod-backup verification", () => {
  it("counts COPY rows per table", () => {
    expect(countCopyRows(DATA)).toEqual({ "public.jobs": 2, "auth.users": 1, "public.organizations": 0 });
    expect(() => countCopyRows('COPY public.jobs (id) FROM stdin;\nx\n')).toThrow(/ends inside/);
  });

  it("dry run executes nothing, writes nothing and hides the host", () => {
    const out = join(scratch(), "b");
    const calls = [];
    const q = quiet();
    const code = main(["--out", out, "--url-env", "U", "--dry-run"], { env: { U: FAKE_URL }, run: fakeRunner({}, calls), bins, ...q });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
    expect(q.lines.join("\n")).not.toMatch(/s3cr3t|pooler\.example|fakeref/);
    expect(q.lines.join("\n")).toMatch(/env: PGPASSWORD\]/);
    expect(q.lines.join("\n")).toMatch(/env: PGHOST/);
  });

  it("dumps, writes manifest and checksums, and verifies", () => {
    const out = join(scratch(), "b");
    const calls = [];
    const q = quiet();
    const code = main(["--out", out, "--url-env", "U"], { env: { U: FAKE_URL }, run: fakeRunner(GOOD, calls), bins, ...q });
    expect(q.lines.join("\n")).toMatch(/verify PASS \(integrity only; run scripts\/window-1\/restore-check\.mjs next\)/);
    expect(code).toBe(0);
    expect(calls).toHaveLength(4);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, "data.sql")).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.rowCounts["public.jobs"]).toBe(2);
    expect(JSON.stringify(manifest)).not.toMatch(/s3cr3t|pooler\.example/);
    expect(main(["--verify", out], q)).toBe(0);
  });

  it("refuses to run without the URL variable", () => {
    const q = quiet();
    expect(main(["--out", join(scratch(), "b")], { env: {}, bins, ...q })).toBe(2);
    expect(q.lines.join("\n")).toMatch(/manual commands/);
  });

  it("fails on a missing or empty file, a count mismatch, a tampered file, or a failed step", () => {
    const run = (files, status = 0) => {
      const out = join(scratch(), "b");
      const runner = status ? () => ({ status, stderr: "boom for user postgres.fakeref at pooler.example.invalid" }) : fakeRunner(files, []);
      const q = quiet();
      return { out, q, code: main(["--out", out, "--url-env", "U"], { env: { U: FAKE_URL }, run: runner, bins, ...q }) };
    };
    expect(run({ ...GOOD, "data.sql": "" }).code).toBe(1);
    const noPolicies = run({ ...GOOD, "storage-policies.sql": "" });
    expect(noPolicies.code).toBe(1);
    expect(noPolicies.q.lines.join("\n")).toMatch(/storage-policies.sql is empty/);
    const mismatch = run({ ...GOOD, "counts.prod.json": JSON.stringify({ "public.jobs": 3 }) });
    expect(mismatch.code).toBe(1);
    expect(mismatch.q.lines.join("\n")).toMatch(/row count mismatch for public.jobs: live 3, dump 2/);
    const good = run(GOOD);
    expect(good.code).toBe(0);
    writeFileSync(join(good.out, "schema.sql"), SCHEMA + "-- tampered\n");
    const v = verifyBackup(good.out);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("checksum mismatch for schema.sql");
    const failed = run({}, 1);
    expect(failed.code).toBe(1);
    expect(failed.q.lines.join("\n")).not.toMatch(/fakeref|pooler\.example/);
    const partial = join(scratch(), "partial");
    mkdirSync(partial);
    writeFileSync(join(partial, "schema.sql"), 'CREATE TABLE "public"."jobs" (id uuid);\n');
    expect(verifyBackup(partial).problems).toEqual(expect.arrayContaining([
      "counts.prod.json is missing", "SHA256SUMS is missing", "schema.sql has no CREATE TABLE in engineering_private",
    ]));
  });
});
