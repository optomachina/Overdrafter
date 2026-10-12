// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffInventories, formatInventory, isEmptyDiff, parseInventory, renderDiff } from "./ovd602-diff.mjs";
import {
  extractDraft, needsOwnTransaction, packetBody, parsePgTap, suitePassed, uncommentSection,
} from "./rehearse.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const inventory = (overrides = {}) => ({
  format: "ovd602.inventory.v1",
  schemas: [{ name: "public", usage: ["anon", "authenticated", "service_role"] }],
  functions: [{ signature: "public.f(uuid)", definer: true, search_path: '""', execute: ["service_role"] }],
  relations: [{ name: "public.t", kind: "r", rls: true, force_rls: false, grants: { service_role: ["SELECT"] } }],
  policies: [{ table: "public.t", name: "p", cmd: "SELECT", permissive: "PERMISSIVE", roles: ["authenticated"], using_md5: "a", check_md5: "b" }],
  ...overrides,
});

describe("ovd602 inventory diff", () => {
  it("reports no difference for identical inventories", () => {
    const diff = diffInventories(inventory(), inventory());
    expect(isEmptyDiff(diff)).toBe(true);
    expect(renderDiff(diff)).toContain("no difference");
  });

  it("flags a new definer function that anon can execute and one without a pinned search_path", () => {
    const current = inventory({
      functions: [
        ...inventory().functions,
        { signature: "public.g()", definer: true, search_path: null, execute: ["PUBLIC", "anon"] },
      ],
    });
    const diff = diffInventories(inventory(), current);
    expect(diff.added.functions.map((f) => f.signature)).toEqual(["public.g()"]);
    expect(diff.flags).toContain("DEFINER_WITHOUT_SEARCH_PATH added public.g()");
    expect(diff.flags).toContain("DEFINER_EXECUTABLE_BY PUBLIC,anon added public.g()");
  });

  it("flags a grant change, an RLS change and a policy rewrite as changes", () => {
    const current = inventory({
      relations: [{ name: "public.t", kind: "r", rls: false, force_rls: false, grants: { anon: ["SELECT"], service_role: ["SELECT"] } }],
      policies: [{ ...inventory().policies[0], using_md5: "changed" }],
    });
    const diff = diffInventories(inventory(), current);
    expect(diff.changed.relations[0].key).toBe("public.t");
    expect(diff.flags).toEqual(expect.arrayContaining([
      "RELATION_GRANTED_TO anon changed public.t", "RLS_DISABLED changed public.t", "POLICY_CHANGED public.t p",
    ]));
  });

  it("treats a removed object as a difference", () => {
    const diff = diffInventories(inventory(), inventory({ policies: [] }));
    expect(isEmptyDiff(diff)).toBe(false);
    expect(diff.flags).toContain("POLICY_REMOVED public.t p");
  });

  it("round trips the pinned file format", () => {
    const text = formatInventory(inventory());
    expect(diffInventories(inventory(), parseInventory(text)).flags).toEqual([]);
    expect(() => parseInventory('{"format":"other"}')).toThrow(/format/);
  });
});

describe("window 1 rehearsal helpers", () => {
  const draft = [
    "-- header", "create table a();", "", "-- =====", "-- PHASE 2 - CONTRACT", "-- =====",
    "drop policy x on y;", "-- =====", "-- ROLLBACK", "-- =====", "-- begin;", "-- drop table a;", "--", "-- commit;",
  ].join("\n");

  it("cuts PHASE 1 before the PHASE 2 banner and PHASE 2 before the ROLLBACK banner", () => {
    expect(extractDraft(draft, { endBeforeLineMatching: "^-- PHASE 2 - CONTRACT" })).toBe("-- header\ncreate table a();\n");
    expect(extractDraft(draft, { startAtBannerBefore: "^-- PHASE 2 - CONTRACT", endBeforeLineMatching: "^-- ROLLBACK$" }))
      .toBe("-- =====\n-- PHASE 2 - CONTRACT\n-- =====\ndrop policy x on y;\n");
    expect(() => extractDraft(draft, { endBeforeLineMatching: "^-- PHASE 9" })).toThrow(/not found/);
  });

  it("uncomments a rollback section without changing anything else", () => {
    expect(uncommentSection(draft, "-- begin;", "-- commit;")).toBe("begin;\ndrop table a;\n\ncommit;\n");
  });

  it("detects files that cannot run inside one wrapping transaction", () => {
    expect(needsOwnTransaction("create index concurrently i on t (a);")).toBe(true);
    expect(needsOwnTransaction("begin;\nselect 1;\ncommit;")).toBe(true);
    expect(needsOwnTransaction("create table t (a int); -- begin later")).toBe(false);
  });

  it("passes a pgTAP run only when every planned assertion is ok", () => {
    const tap = parsePgTap(" 1..3\n ok 1 - a\n ok 2 - b\n not ok 3 - c\n");
    expect(tap).toMatchObject({ planned: 3, ok: 2, notOk: 1 });
    expect(suitePassed({ rc: 0, ...tap })).toBe(false);
    expect(suitePassed({ rc: 0, ...parsePgTap("1..2\nok 1\nok 2\n") })).toBe(true);
    expect(suitePassed({ rc: 3, ...parsePgTap("1..2\nok 1\nok 2\n") })).toBe(false);
    expect(suitePassed({ rc: 0, ...parsePgTap("ok 1\n") })).toBe(false);
  });
});

describe("window 1 packet files", () => {
  const manifest = JSON.parse(read("docs/release/window-1/manifest.json"));

  it("pins full commit SHAs and points at files that exist", () => {
    for (const sha of [manifest.base.sha, ...manifest.migrations.map((m) => m.sha)]) expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set(manifest.recommendedOrder)).toEqual(new Set(manifest.migrations.map((m) => m.id)));
    for (const m of manifest.migrations) if (m.rollback.packet) expect(read(m.rollback.packet).length).toBeGreaterThan(0);
  });

  it("keeps the derived 722 rollback body free of edits after the marker", () => {
    const body = packetBody(read("docs/release/window-1/rollback/ovd-722.rollback.sql"));
    expect(body.startsWith("begin;\n")).toBe(true);
    expect(body.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("has a parseable pin and expected diffs whose new definer functions all pin search_path", () => {
    const pin = parseInventory(read(manifest.pin));
    expect(pin.functions.filter((f) => f.definer && !f.search_path)).toEqual([]);
    const dir = manifest.expectedDiffDir;
    const files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".json"));
    expect(files).toContain(`${manifest.recommendedOrder.join("+")}.json`);
    for (const f of files) {
      const diff = JSON.parse(read(join(dir, f)));
      expect(diff.format).toBe("ovd602.diff.v1");
      expect(diff.flags.filter((x) => x.startsWith("DEFINER_WITHOUT_SEARCH_PATH"))).toEqual([]);
    }
  });
});

describe("window 1 restore check", async () => {
  const { isLocalTarget, compareCounts, repoRoles, CLEAR_DEFAULT_PRIVILEGES } = await import("./restore-check.mjs");

  it("accepts only loopback hosts and Unix sockets as restore targets", () => {
    expect(isLocalTarget("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBe(true);
    expect(isLocalTarget("postgresql://postgres@localhost/postgres")).toBe(true);
    expect(isLocalTarget("postgresql:///postgres?host=/tmp/sock&user=postgres")).toBe(true);
    expect(isLocalTarget("postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres")).toBe(false);
    expect(isLocalTarget("postgresql://u@127.0.0.1/db?host=db.example.com")).toBe(false);
    expect(isLocalTarget("postgresql:///postgres?host=relative")).toBe(false);
    expect(isLocalTarget("mysql://127.0.0.1/db")).toBe(false);
    expect(isLocalTarget("not a url")).toBe(false);
  });

  it("reports every count that differs, including tables missing on one side", () => {
    expect(compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
    expect(compareCounts({ a: 1, b: 2 }, { a: 1, b: 3, c: 0 })).toEqual(["b: production 2 restore 3", "c: production undefined restore 0"]);
  });

  it("finds the NOLOGIN roles that repository migrations create", () => {
    expect(repoRoles()).toEqual(expect.arrayContaining(["ovd575_observer_validator", "ovd576_stop_validator"]));
  });

  it("clears default grants to the API roles before the schema loads", () => {
    for (const kind of ["tables", "sequences", "functions"]) {
      expect(CLEAR_DEFAULT_PRIVILEGES).toContain(`revoke all on ${kind} from anon, authenticated, service_role`);
    }
  });
});

describe("window 1 run sheet consistency", () => {
  const manifest = JSON.parse(read("docs/release/window-1/manifest.json"));
  const readme = read("docs/release/window-1/README.md");
  const summary = JSON.parse(read("docs/release/window-1/rehearsal/recommended/summary.json"));

  it("names every pinned PR head and the base in the README", () => {
    expect(readme).toContain(`\`${manifest.base.sha.slice(0, 8)}\``);
    for (const m of manifest.migrations) expect(readme).toContain(`${m.sha.slice(0, 8)}`);
  });

  it("matches the rehearsed bytes: README sha256 values equal the summary", () => {
    for (const m of manifest.migrations) {
      const rehearsed = summary.migrations.find((x) => x.id === m.id);
      expect(rehearsed.sha).toBe(m.sha);
      expect(readme).toContain(rehearsed.forwardSha256);
    }
    expect(summary.base.sha).toBe(manifest.base.sha);
    expect(summary.pass).toBe(true);
  });

  it("states the rollback sha256 values the summary recorded", () => {
    for (const m of summary.migrations) expect(readme).toContain(m.rollbackSha256);
  });

  it("keeps the runnable 722 rollback equal to the hash in the README", async () => {
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(read("docs/release/window-1/rollback/ovd-722.rollback.sql")).digest("hex");
    expect(readme).toContain(digest);
  });

  it("has an expected 602 diff for every order the README names", () => {
    for (const f of readme.matchAll(/ovd602-expected\/([a-z0-9+-]+\.json)/g)) {
      expect(read(`docs/release/window-1/ovd602-expected/${f[1]}`).length).toBeGreaterThan(0);
    }
  });
});

describe("window 1 safeguards", async () => {
  const { assertReplaceableOut, readmeReadbacks } = await import("./rehearse.mjs");
  const { isLocalTarget } = await import("./restore-check.mjs");
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  it("refuses to wipe a directory that is not a rehearsal output", () => {
    const dir = mkdtempSync(join(tmpdir(), "w1-out-"));
    mkdirSync(join(dir, "evidence"));
    writeFileSync(join(dir, "summary.json"), "{}");
    expect(() => assertReplaceableOut(dir)).not.toThrow();
    writeFileSync(join(dir, "REPORT.md"), "keep me");
    expect(() => assertReplaceableOut(dir)).toThrow(/REPORT\.md/);
    expect(() => assertReplaceableOut(join(dir, "missing"))).not.toThrow();
  });

  it("extracts each migration's readback SQL from the run sheet", () => {
    const blocks = readmeReadbacks(read("docs/release/window-1/README.md"));
    expect(Object.keys(blocks).sort((a, b) => a.localeCompare(b))).toEqual(["ovd-462", "ovd-722", "ovd-723"]);
    for (const sqls of Object.values(blocks)) expect(sqls.length).toBeGreaterThan(0);
  });

  it("rejects hostaddr and service parameters on a restore target", () => {
    expect(isLocalTarget("postgresql://u@127.0.0.1/db?hostaddr=10.0.0.5")).toBe(false);
    expect(isLocalTarget("postgresql://u@127.0.0.1/db?service=prod")).toBe(false);
  });
});

describe("window 1 psql resolution", async () => {
  const { resolvePsql, PSQL_CANDIDATES } = await import("./restore-check.mjs");

  it("uses an absolute OVD_PSQL, else the first standard location, never a PATH lookup", () => {
    expect(resolvePsql({ OVD_PSQL: "/opt/pg/bin/psql" }, (p) => p === "/opt/pg/bin/psql")).toBe("/opt/pg/bin/psql");
    expect(() => resolvePsql({ OVD_PSQL: "psql" }, () => true)).toThrow(/absolute/);
    expect(resolvePsql({}, (p) => p === PSQL_CANDIDATES[2])).toBe(PSQL_CANDIDATES[2]);
    expect(() => resolvePsql({}, () => false)).toThrow(/OVD_PSQL/);
    for (const p of PSQL_CANDIDATES) expect(p.startsWith("/")).toBe(true);
  });
});

describe("window 1 PostgreSQL major version", async () => {
  const { maintainOnlyOnOneSide } = await import("./ovd602-diff.mjs");
  const manifest = JSON.parse(read("docs/release/window-1/manifest.json"));
  const pin = parseInventory(read(manifest.pin));

  it("pins production's major version, PostgreSQL 17", () => {
    expect(manifest.postgresMajor).toBe(17);
  });

  it("has a PostgreSQL 17 pin: MAINTAIN is granted where the other table privileges are", () => {
    const withMaintain = pin.relations.filter((r) => Object.values(r.grants).some((p) => p.includes("MAINTAIN")));
    expect(withMaintain.length).toBe(56);
  });

  it("diffs a PostgreSQL 17 style inventory (MAINTAIN present) clean against the pin", () => {
    const pg17 = JSON.parse(JSON.stringify(pin));
    expect(isEmptyDiff(diffInventories(pin, pg17))).toBe(true);
    expect(maintainOnlyOnOneSide(pin, pg17)).toBe(false);
  });

  it("flags a PostgreSQL 16 style inventory (no MAINTAIN) as a major version mismatch", () => {
    const pg16 = JSON.parse(JSON.stringify(pin));
    for (const r of pg16.relations) for (const k of Object.keys(r.grants)) r.grants[k] = r.grants[k].filter((p) => p !== "MAINTAIN");
    expect(isEmptyDiff(diffInventories(pin, pg16))).toBe(false);
    expect(maintainOnlyOnOneSide(pin, pg16)).toBe(true);
  });
});
