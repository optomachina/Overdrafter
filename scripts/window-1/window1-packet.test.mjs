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
