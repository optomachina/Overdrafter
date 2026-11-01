import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROOT, buildPlan, checkOutDir, countCopyRows, describeUrl, main, parseArgs, resolveSource, urlToPgEnv, verifyBackup,
} from "./prod-backup.mjs";

const FAKE_URL = "postgresql://postgres.fakeref:s3cr3t-Pw@pooler.example.invalid:5432/postgres";
const SCHEMA = 'CREATE TABLE "public"."jobs" (id uuid);\nCREATE TABLE "public"."organizations" (id uuid);\n';
const DATA = [
  'COPY "public"."jobs" ("id") FROM stdin;', "a", "b", "\\.", "",
  'COPY "auth"."users" ("id") FROM stdin;', "u", "\\.", "",
  'COPY "public"."organizations" ("id") FROM stdin;', "\\.", "",
].join("\n");
const COUNTS = JSON.stringify({ "public.jobs": 2, "auth.users": 1, "public.organizations": 0, "public.payments": null });

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
    const target = step.cmd === "psql" ? step.args[step.args.indexOf("-o") + 1] : step.args[step.args.indexOf("-f") + 1];
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
  });

  it("describes a URL without host or password", () => {
    const d = describeUrl(FAKE_URL);
    expect(d).not.toMatch(/s3cr3t|pooler\.example|fakeref/);
  });

  it("prefers the named URL variable and falls back to the linked supabase CLI", () => {
    const viaUrl = resolveSource({ env: { MY_URL: FAKE_URL }, urlEnv: "MY_URL", hasCommand: () => true });
    expect(viaUrl.kind).toBe("db-url");
    expect(viaUrl.pgEnv).toMatchObject({ PGHOST: "pooler.example.invalid", PGUSER: "postgres.fakeref", PGPASSWORD: "s3cr3t-Pw", PGSSLMODE: "require" });
    expect(resolveSource({ env: {}, urlEnv: "MY_URL", hasCommand: () => true }).kind).toBe("supabase-linked");
    expect(resolveSource({ env: {}, urlEnv: "MY_URL", hasCommand: () => false }).kind).toBe("none");
    expect(() => urlToPgEnv("https://example.invalid")).toThrow(/postgres/);
  });

  it("never puts the secret or host in a command argument", () => {
    const source = resolveSource({ env: { U: FAKE_URL }, urlEnv: "U", hasCommand: () => false });
    const plan = buildPlan(source, "/tmp/out");
    expect(plan.map((s) => s.name)).toEqual(["schema", "data", "counts", "storage-policies"]);
    for (const s of plan) expect(s.args.join(" ")).not.toMatch(/s3cr3t|pooler\.example|postgres(ql)?:\/\//);
    const linked = buildPlan({ kind: "supabase-linked" }, "/tmp/out");
    expect(linked.every((s) => s.args.includes("--linked"))).toBe(true);
  });

  it("refuses an output directory inside the repo or one that exists", () => {
    expect(() => checkOutDir(join(ROOT, "backup"))).toThrow(/outside the repository/);
    expect(() => checkOutDir(scratch())).toThrow(/must not exist/);
  });
});

describe("prod-backup verification", () => {
  it("counts COPY rows per table", () => {
    expect(countCopyRows(DATA)).toEqual({ "public.jobs": 2, "auth.users": 1, "public.organizations": 0 });
    expect(() => countCopyRows('COPY public.jobs (id) FROM stdin;\nx\n')).toThrow(/ends inside/);
  });

  it("dry run executes nothing and writes nothing", () => {
    const out = join(scratch(), "b");
    const calls = [];
    const q = quiet();
    const code = main(["--out", out, "--url-env", "U", "--dry-run"], { env: { U: FAKE_URL }, run: fakeRunner({}, calls), hasCommand: () => true, ...q });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
    expect(q.lines.join("\n")).not.toMatch(/s3cr3t|pooler\.example/);
    expect(q.lines.join("\n")).toMatch(/env: PGHOST/);
  });

  it("dumps, writes manifest and checksums, and verifies (db-url path)", () => {
    const out = join(scratch(), "b");
    const calls = [];
    const q = quiet();
    const files = { "schema.sql": SCHEMA, "data.sql": DATA, "counts.prod.json": COUNTS, "storage-policies.sql": "create policy x;\n" };
    const code = main(["--out", out, "--url-env", "U"], { env: { U: FAKE_URL }, run: fakeRunner(files, calls), hasCommand: () => true, ...q });
    expect(q.lines.join("\n")).toMatch(/verify PASS/);
    expect(code).toBe(0);
    expect(calls).toHaveLength(4);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, "data.sql")).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.rowCounts["public.jobs"]).toBe(2);
    expect(JSON.stringify(manifest)).not.toMatch(/s3cr3t|pooler\.example/);
    expect(main(["--verify", out], q)).toBe(0);
  });

  it("verifies the supabase-linked fallback without live counts", () => {
    const out = join(scratch(), "b");
    const calls = [];
    const code = main(["--out", out], { env: {}, run: fakeRunner({ "schema.sql": SCHEMA, "data.sql": DATA }, calls), hasCommand: () => true, ...quiet() });
    expect(code).toBe(0);
    expect(calls.map((c) => c.cmd)).toEqual(["supabase", "supabase"]);
  });

  it("fails on an empty dump, a count mismatch, a tampered file, or a failed step", () => {
    const run = (files, status = 0) => {
      const out = join(scratch(), "b");
      const calls = [];
      const runner = status ? () => ({ status, stderr: `boom ${FAKE_URL.split("@")[0]}` }) : fakeRunner(files, calls);
      const q = quiet();
      return { out, q, code: main(["--out", out, "--url-env", "U"], { env: { U: FAKE_URL }, run: runner, hasCommand: () => true, ...q }) };
    };
    expect(run({ "schema.sql": SCHEMA, "data.sql": "", "counts.prod.json": COUNTS, "storage-policies.sql": "x" }).code).toBe(1);
    const mismatch = run({ "schema.sql": SCHEMA, "data.sql": DATA, "counts.prod.json": JSON.stringify({ "public.jobs": 3 }), "storage-policies.sql": "x" });
    expect(mismatch.code).toBe(1);
    expect(mismatch.q.lines.join("\n")).toMatch(/row count mismatch for public.jobs: live 3, dump 2/);
    const good = run({ "schema.sql": SCHEMA, "data.sql": DATA, "counts.prod.json": COUNTS, "storage-policies.sql": "x" });
    expect(good.code).toBe(0);
    writeFileSync(join(good.out, "schema.sql"), SCHEMA + "-- tampered\n");
    const v = verifyBackup(good.out);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("checksum mismatch for schema.sql");
    expect(run({}, 1).code).toBe(1);
  });
});
