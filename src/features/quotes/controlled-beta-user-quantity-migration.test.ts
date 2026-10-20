// @vitest-environment node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * OVD-987 (P3): text pins for the controlled_beta_user_quantity migration and
 * its rollback. The database behaviour is proven by
 * supabase/tests/ovd987_controlled_beta_user_quantity.sql; these pins keep
 * the reviewed shape from drifting without a database.
 */

const MIGRATIONS = "supabase/migrations";
const MIGRATION_FILE = "20261020100000_ovd987_controlled_beta_user_quantity.sql";
const migrationSql = readFileSync(`${MIGRATIONS}/${MIGRATION_FILE}`, "utf8");
const rollbackSql = readFileSync("docs/migration-drafts/ovd-987.rollback.sql", "utf8");
const sqlFiles = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();

// [function, the migration that held its latest definition before OVD-987]
const RESTATED: ReadonlyArray<readonly [string, string]> = [
  ["public.api_set_commercial_rollout_control", "20260802020349_add_commercial_rollout_controls.sql"],
  ["private.resolve_xometry_beta_dispatch_scope_with_access", "20261010230000_ovd679_member_sourcing_destination.sql"],
  ["public.api_request_xometry_beta_dispatch", "20261004100000_ovd598_serialize_legacy_xometry_admission.sql"],
  ["public.api_authorize_xometry_beta_worker_dispatch", "20261002182910_free_confirmed_quote_access.sql"],
  ["private.record_quote_access_admission", "20261002182714_free_quote_job_meter.sql"],
  ["private.finalize_free_quote_job", "20261002182714_free_quote_job_meter.sql"],
  ["public.api_reconcile_terminal_free_quote_tasks", "20261003011148_reconcile_free_quote_job_reservations.sql"],
];

const definitionPattern = (qualified: string) =>
  new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${qualified.replace(".", "\\.")}\\s*\\(`, "gi");

/** pg_proc.prosrc of the single definition of `qualified` in `sql`. */
function body(sql: string, qualified: string): string {
  const hits = [...sql.matchAll(definitionPattern(qualified))];
  expect(hits, qualified).toHaveLength(1);
  const open = sql.indexOf("as $$", hits[0]?.index ?? 0) + "as $$".length;
  return sql.slice(open, sql.indexOf("$$", open));
}

const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("OVD-987 controlled beta user quantity migration", () => {
  it("is the newest definition of every restated function (a later redefinition must rebase onto it)", () => {
    for (const [qualified] of RESTATED) {
      const defining = sqlFiles.filter((name) =>
        definitionPattern(qualified).test(readFileSync(`${MIGRATIONS}/${name}`, "utf8")),
      );
      expect(defining.at(-1), qualified).toBe(MIGRATION_FILE);
    }
  });

  it("rolls every restated function back to its previous body byte for byte", () => {
    for (const [qualified, source] of RESTATED) {
      expect(body(rollbackSql, qualified), qualified).toBe(body(readFileSync(`${MIGRATIONS}/${source}`, "utf8"), qualified));
    }
  });

  it("guards both directions with the previous and the new body md5", () => {
    for (const [qualified, source] of RESTATED) {
      const previous = md5(body(readFileSync(`${MIGRATIONS}/${source}`, "utf8"), qualified));
      const next = md5(body(migrationSql, qualified));
      expect(previous, qualified).not.toBe(next);
      expect(migrationSql, qualified).toContain(`'${previous}', '${next}'`);
      expect(rollbackSql, qualified).toContain(`'${next}', '${previous}'`);
    }
  });

  it("seeds the switch off through the existing registry and keeps it settable only by the audited setter", () => {
    const seed = flat(migrationSql);
    expect(seed).toContain("values ( 'controlled_beta_user_quantity', false, 0,");
    expect(seed).toContain("on conflict (capability) do nothing;");
    expect(flat(body(migrationSql, "public.api_set_commercial_rollout_control"))).toContain(
      "'order_administration', 'controlled_beta_user_quantity' ) then raise exception 'Unknown commercial rollout capability.';",
    );
    expect(seed).toContain(
      "create or replace function private.xometry_beta_user_quantity_enabled() returns boolean language sql stable set search_path = pg_catalog as $$ select private.commercial_rollout_enabled('controlled_beta_user_quantity'); $$; revoke all on function private.xometry_beta_user_quantity_enabled() from public, anon, authenticated, service_role;",
    );
  });

  it("keeps the quantity-one rule while the switch is off and admits exactly one positive quantity while it is on", () => {
    const resolver = flat(body(migrationSql, "private.resolve_xometry_beta_dispatch_scope_with_access"));
    expect(resolver).toContain(
      ") is distinct from array[1]::integer[] and not private.xometry_beta_user_quantity_enabled() then raise exception 'xometry_beta_quantity_one_required';",
    );
    expect(resolver).toContain(
      "if pg_catalog.cardinality(public.normalize_positive_integer_array( v_requirement.quote_quantities, v_requirement.quantity )) <> 1 then raise exception 'xometry_beta_single_quantity_required';",
    );
    // Blaine, 2026-10-19: no product cap.
    expect(migrationSql).not.toMatch(/above_limit|max_quantity/);
    // The quantity gate still runs before applicability and tolerance.
    expect(resolver.indexOf("xometry_beta_single_quantity_required")).toBeLessThan(
      resolver.indexOf("xometry_beta_xometry_applicability_required"),
    );
    expect(resolver.indexOf("xometry_beta_manufacturing_quote_only")).toBeLessThan(
      resolver.indexOf("xometry_beta_quantity_one_required"),
    );
  });

  it("re-checks the switch at dispatch and refuses a lane above 1 while it is off", () => {
    const preflight = flat(body(migrationSql, "public.api_authorize_xometry_beta_worker_dispatch"));
    expect(preflight).toContain(
      "if v_lane.requested_quantity <> 1 then perform pg_catalog.pg_advisory_xact_lock_shared( pg_catalog.hashtextextended('commercial-rollout:controlled_beta_user_quantity', 0) ); if not private.xometry_beta_user_quantity_enabled() then return pg_catalog.jsonb_build_object( v_authorized_key, false, v_reason_key, 'dispatch_quantity_not_admitted' );",
    );
    expect(preflight.indexOf("'dispatch_rollout_disabled'")).toBeLessThan(preflight.indexOf("'dispatch_quantity_not_admitted'"));
    expect(preflight).toContain("and candidate.requested_quantity = v_lane.requested_quantity;");
  });

  it("never lets the free-beta meter read the switch, so a permit issued at N still settles", () => {
    for (const qualified of [
      "private.record_quote_access_admission",
      "private.finalize_free_quote_job",
      "public.api_reconcile_terminal_free_quote_tasks",
    ]) {
      const meter = body(migrationSql, qualified);
      expect(meter, qualified).not.toContain("xometry_beta_user_quantity_enabled");
      expect(meter, qualified).not.toContain("commercial_rollout");
      expect(meter, qualified).not.toMatch(/requested_quantity (?:<>|=|is distinct from) 1\b/);
      expect(meter, qualified).toContain("requested_quantity::text");
      expect(meter, qualified).toContain("scope_snapshot ->> 'quantity')");
    }
  });
});
