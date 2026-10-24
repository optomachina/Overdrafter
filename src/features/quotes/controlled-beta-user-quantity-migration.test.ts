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

  it("binds the quantity the worker browses with (result row and payload key) to the lane", () => {
    const preflight = flat(body(migrationSql, "public.api_authorize_xometry_beta_worker_dispatch"));
    const binding =
      "or v_lane.requested_quantity::text is distinct from (v_lane.scope_snapshot ->> 'quantity') " +
      "or v_result.requested_quantity is distinct from v_lane.requested_quantity " +
      "or (v_task.payload ? 'requestedQuantity' and v_task.payload ->> 'requestedQuantity' is distinct from v_lane.requested_quantity::text) " +
      "or v_lane.scope_version <> v_permit.scope_version";
    expect(preflight).toContain(binding);
    // Inside the lane identity block, so it returns the existing reason.
    const at = preflight.indexOf(binding);
    expect(at).toBeGreaterThan(preflight.indexOf("select lane_row.* into v_lane"));
    expect(at).toBeLessThan(preflight.indexOf("v_reason_key, 'dispatch_lane_identity_mismatch'"));
    expect(preflight.indexOf("select result_row.* into v_result")).toBeLessThan(at);
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

/** The text of a dollar-quoted DO block, from its opening line to its closing tag. */
function doBlock(sql: string, tag: string): { start: number; end: number; text: string } {
  const start = sql.indexOf(`\ndo $${tag}$\n`);
  const end = sql.indexOf(`\n$${tag}$;\n`);
  expect(start, tag).toBeGreaterThan(0);
  expect(end, tag).toBeGreaterThan(start);
  return { start, end, text: flat(sql.slice(start, end)) };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One VALUES row of a guard: ('<signature>', '<md5>', '<md5>'). */
const guardRow = (qualified: string, first: string, second: string) =>
  new RegExp(`\\('${escapeRegExp(qualified)}\\([^)]*\\)', '${first}', '${second}'\\)`);
const GUARD_ROW = /\('[a-z_]+\.[a-z_]+\([^)]*\)', '[0-9a-f]{32}', '[0-9a-f]{32}'\)/g;

describe("OVD-987 migration precondition", () => {
  const block = doBlock(migrationSql, "ovd987_precondition");

  it("runs after lock_timeout and before any change", () => {
    expect(block.start).toBeGreaterThan(migrationSql.indexOf("\nset local lock_timeout = '5s';\n"));
    expect(migrationSql.search(/^(?:alter table|insert into|create or replace function|drop |revoke |grant )/m)).toBeGreaterThan(block.end);
  });

  it.each(RESTATED)("accepts only the reviewed previous body or this file's body of %s", (qualified, source) => {
    const previous = md5(body(readFileSync(`${MIGRATIONS}/${source}`, "utf8"), qualified));
    const next = md5(body(migrationSql, qualified));
    expect(block.text).toMatch(guardRow(qualified, previous, next));
  });

  it("checks exactly the seven restated functions and raises on a missing or unknown body", () => {
    expect(block.text.match(GUARD_ROW)).toHaveLength(RESTATED.length);
    expect(block.text).toContain(
      "select pg_catalog.md5(p.prosrc) into v_md5 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(v_expected.signature);",
    );
    expect(block.text).toContain(
      "if v_md5 is null or v_md5 not in (v_expected.previous_md5, v_expected.applied_md5) then raise exception 'OVD-987 refused:",
    );
  });
});

/** Both rollout tables in one NOWAIT statement: the attempt the migration and the rollback both make. */
const TRY_LOCK =
  "lock table private.commercial_rollout_control_events, private.commercial_rollout_controls in access exclusive mode nowait;";

/**
 * A lock block that takes every table all or nothing and never waits: each attempt runs in its own
 * exception block, so a refused NOWAIT gives back what the attempt took, then it sleeps holding nothing
 * and retries until a 5 s deadline, after which it raises 55P03 and the whole file rolls back.
 */
function expectTryLockLoop(text: string, attempt: string, refusal: string) {
  expect(text).toContain(
    "declare v_deadline timestamptz := pg_catalog.clock_timestamp() + interval '5 seconds'; " +
      `begin loop begin ${attempt} exit; exception when lock_not_available then ` +
      `if pg_catalog.clock_timestamp() >= v_deadline then raise exception '${refusal}`,
  );
  expect(text).toContain("using errcode = '55P03'; end if; end; perform pg_catalog.pg_sleep(0.05); end loop; end;");
  // Only a refused NOWAIT is retried; any other error still aborts the file.
  expect(text.match(/ exception when /g)).toHaveLength(1);
  // Every LOCK in the block is NOWAIT: a waiting LOCK could close a cycle with the setter or the read API.
  expect(text.match(/lock table [^;]*;/g)?.every((statement) => statement.endsWith(" nowait;"))).toBe(true);
}

describe("OVD-987 migration locks", () => {
  const precondition = doBlock(migrationSql, "ovd987_precondition");
  const locks = doBlock(migrationSql, "ovd987_locks");

  it("takes both rollout tables all or nothing and without waiting, after the precondition and before any change", () => {
    expectTryLockLoop(locks.text, TRY_LOCK, "OVD-987 refused: the rollout-control tables stayed in use for 5 s;");
    expect(migrationSql.match(/^\s*lock table /gm)).toHaveLength(1);
    expect(locks.start).toBeGreaterThan(precondition.end);
    // Neither rollout table is touched by a statement before its lock (the first ALTER TABLE follows both).
    expect(migrationSql.search(/^(?:alter table|insert into|create or replace function|drop |revoke |grant )/m)).toBeGreaterThan(locks.end);
    expect(migrationSql.search(/^alter table private\.commercial_rollout_control/m)).toBeGreaterThan(locks.end);
  });

  it("has no top-level LOCK TABLE, which errors in the CLI's pipeline and in a statement-at-a-time psql", () => {
    expect(migrationSql).not.toMatch(/^lock table /m);
  });

  it("never waits for a table, because the setter and the read API take the two tables in opposite orders", () => {
    // The setter reads the events (idempotency lookup) before it locks a control row ...
    const setter = flat(body(migrationSql, "public.api_set_commercial_rollout_control"));
    const readsEvents = setter.indexOf("from private.commercial_rollout_control_events event where event.idempotency_key");
    const locksControl = setter.indexOf("from private.commercial_rollout_controls control where control.capability = p_capability for update");
    expect(readsEvents).toBeGreaterThan(0);
    expect(locksControl).toBeGreaterThan(readsEvents);
    // ... while the read API (unchanged since it was created) reads the controls, then the events, in one statement.
    const readApi = flat(body(readFileSync(`${MIGRATIONS}/20260802020349_add_commercial_rollout_controls.sql`, "utf8"), "public.api_get_commercial_rollout_controls"));
    const readsControls = readApi.indexOf("from private.commercial_rollout_controls control");
    expect(readsControls).toBeGreaterThan(0);
    expect(readApi.indexOf("from private.commercial_rollout_control_events event")).toBeGreaterThan(readsControls);
    expect(sqlFiles.filter((name) => definitionPattern("public.api_get_commercial_rollout_controls").test(readFileSync(`${MIGRATIONS}/${name}`, "utf8")))).toEqual([
      "20260802020349_add_commercial_rollout_controls.sql",
    ]);
    // So no waiting order is safe for either file; both make the same NOWAIT attempt.
    expect(flat(migrationSql).match(/lock table [^;]*;/g)).toEqual([TRY_LOCK]);
    expect(flat(rollbackSql).match(/lock table [^;]*;/g)).toEqual([
      TRY_LOCK,
      "lock table private.xometry_beta_dispatch_permits in share mode nowait;",
    ]);
  });
});

describe("OVD-987 rollback guard", () => {
  const guard = doBlock(rollbackSql, "ovd987_rollback_guard");

  it("takes the control events, the controls and the permits all or nothing and without waiting, then guards, before restoring anything", () => {
    const lockTimeout = rollbackSql.indexOf("\nset local lock_timeout = '5s';\n");
    const locks = doBlock(rollbackSql, "ovd987_rollback_locks");
    expect(lockTimeout).toBeGreaterThan(0);
    expect(locks.start).toBeGreaterThan(lockTimeout);
    expectTryLockLoop(
      locks.text,
      `${TRY_LOCK} lock table private.xometry_beta_dispatch_permits in share mode nowait;`,
      "OVD-987 rollback refused: the rollout-control or permit tables stayed in use for 5 s;",
    );
    expect(rollbackSql).not.toMatch(/^lock table /m);
    expect(rollbackSql.match(/^\s*lock table /gm)).toHaveLength(2);
    expect(guard.start).toBeGreaterThan(locks.end);
    expect(rollbackSql.search(/^(?:alter table|delete from|create or replace function|drop )/m)).toBeGreaterThan(guard.end);
  });

  it("refuses while the switch is on", () => {
    expect(guard.text).toContain(
      "if private.commercial_rollout_enabled('controlled_beta_user_quantity') then raise exception 'OVD-987 rollback refused: controlled_beta_user_quantity is on;",
    );
  });

  it("refuses while a Xometry permit above quantity 1 has a reserved admission, an open request or an open task", () => {
    expect(guard.text).toContain(
      "if exists ( select 1 from private.xometry_beta_dispatch_permits permit " +
        "join public.quote_request_lanes lane on lane.id = permit.quote_request_lane_id " +
        "left join public.quote_requests request_row on request_row.id = permit.quote_request_id " +
        "left join public.work_queue task on task.id = permit.work_queue_task_id " +
        "left join private.quote_access_admissions admission on admission.permit_id = permit.id " +
        "where lane.requested_quantity <> 1 " +
        "and (admission.state = 'reserved' " +
        "or request_row.status::text in ('queued', 'requesting') " +
        "or task.status::text in ('queued', 'running')) ) " +
        "then raise exception 'OVD-987 rollback refused: a Xometry beta permit above quantity 1 is still in flight;",
    );
  });

  it.each(RESTATED)("refuses when %s is neither this migration's body nor the original", (qualified, source) => {
    const previous = md5(body(readFileSync(`${MIGRATIONS}/${source}`, "utf8"), qualified));
    const next = md5(body(migrationSql, qualified));
    expect(guard.text).toMatch(guardRow(qualified, next, previous));
  });

  it("checks exactly the seven restated functions and raises on a missing or unknown body", () => {
    expect(guard.text.match(GUARD_ROW)).toHaveLength(RESTATED.length);
    expect(guard.text).toContain(
      "select pg_catalog.md5(p.prosrc) into v_md5 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(v_expected.signature);",
    );
    expect(guard.text).toContain(
      "if v_md5 is null or v_md5 not in (v_expected.applied_md5, v_expected.previous_md5) then raise exception 'OVD-987 rollback refused: % was replaced by a later migration",
    );
  });

  it("refuses first, with 55000, while any immutable audit event names the switch", () => {
    // Every setter call writes an event (a no-op call too), and the restored CHECK rejects the value.
    expect(guard.text).toContain(
      " do $ovd987_rollback_guard$ declare v_expected record; v_md5 text; begin " +
        "if exists ( select 1 from private.commercial_rollout_control_events where capability = 'controlled_beta_user_quantity' ) " +
        "then raise exception 'OVD-987 rollback refused: immutable audit events exist for controlled_beta_user_quantity;",
    );
    expect(guard.text).toContain(
      "keep the migration applied with the switch off, or decide on a separate schema removal' using errcode = '55000'; end if; " +
        "if private.commercial_rollout_enabled('controlled_beta_user_quantity') then",
    );
  });

  it("restores both capability CHECKs to their pre-OVD-987 definitions unconditionally", () => {
    const flatRollback = flat(rollbackSql);
    const previousSql = "20260802020349_add_commercial_rollout_controls.sql";
    // That migration holds the latest definition of both CHECKs before OVD-987.
    for (const name of ["commercial_rollout_controls_capability_check", "commercial_rollout_control_events_capability_check"]) {
      expect(sqlFiles.filter((file) => file < MIGRATION_FILE && readFileSync(`${MIGRATIONS}/${file}`, "utf8").includes(name)), name).toEqual([previousSql]);
    }
    const previous = flat(readFileSync(`${MIGRATIONS}/${previousSql}`, "utf8"));
    for (const table of ["commercial_rollout_controls", "commercial_rollout_control_events"]) {
      const check = previous.match(new RegExp(`constraint ${table}_capability_check (check \\( capability in \\([^)]*\\) \\))`))?.[1];
      expect(check, table).toContain("'order_administration' )");
      expect(flatRollback).toContain(
        `alter table private.${table} drop constraint if exists ${table}_capability_check; ` +
          `alter table private.${table} add constraint ${table}_capability_check ${check};`,
      );
      // Top-level statements, not inside a conditional block.
      expect(rollbackSql).toMatch(new RegExp(`^alter table private\\.${table}\\n  add constraint ${table}_capability_check check \\(\\n`, "m"));
    }
    expect(rollbackSql).not.toContain("ovd987_rollback_events");
    expect(rollbackSql).not.toMatch(/raise notice|not valid/i);
  });

  it("never deletes or rewrites an audit event and deletes only a disabled control row", () => {
    const flatRollback = flat(rollbackSql);
    // Outside the restored function bodies ($$ ... $$; the restored setter still appends events when called).
    const statements = flatRollback.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    expect(statements).toContain("do $ovd987_rollback_guard$");
    expect(statements).not.toMatch(/(?:delete from|update|truncate(?: table)?|insert into) private\.commercial_rollout_control_events\b/);
    expect(flatRollback).toContain(
      "delete from private.commercial_rollout_controls where capability = 'controlled_beta_user_quantity' and not enabled;",
    );
  });

  it("is drilled in pgTAP both ways: restore with no audit event, refusal with one", () => {
    const suite = readFileSync("supabase/tests/ovd987_controlled_beta_user_quantity.sql", "utf8");
    const include = "\\ir fixtures/ovd987_controlled_beta_user_quantity_rollback.inc\n";
    const restore = suite.indexOf(`savepoint ovd987_rollback_restores;\n${include}`);
    const noop = suite.indexOf("'ovd987-pgtap-noop-0001'");
    const refusal = suite.indexOf(`\\set ON_ERROR_STOP off\n${include}\\set ON_ERROR_STOP on\n`);
    expect(restore).toBeGreaterThan(0);
    expect(noop).toBeGreaterThan(restore);
    expect(refusal).toBeGreaterThan(noop);
    // Both drills run before the file's own first audited flip.
    expect(suite.indexOf("'ovd987-pgtap-enable-0001'")).toBeGreaterThan(refusal);
    expect(suite).toContain("\\set ON_ERROR_ROLLBACK off\n");
    expect(suite).toContain("select is(:'LAST_ERROR_SQLSTATE'::text, '25P02',");
  });
});
