// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const releaseFile = (name) => readFileSync(path.resolve("docs/release", name), "utf8");
const reverse = releaseFile("native-result-reader-reverse.sql");
const forward = releaseFile("native-result-reader-forward.sql");
const pendingReverse = releaseFile("ovd561-pending-reverse.sql");
const normalize = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

// A deliberately narrow source-contract check, not a SQL interpreter or a
// substitute for disposable PostgreSQL rollback/concurrency qualification.
// Anchoring the whole script prevents a guard-looking comment or a later guard
// from masking an earlier DROP, COMMIT, or swallowed refusal.
const guardedReverse = new RegExp([
  "^begin;",
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '30s';",
  String.raw`lock table engineering_private\.native_result_read_bindings in access exclusive mode;`,
  String.raw`do \$preflight\$ begin`,
  String.raw`if current_user <> 'postgres' or current_setting\('transaction_isolation'\) <> 'read committed'`,
  String.raw`or exists \(select 1 from engineering_private\.native_result_read_bindings\) then`,
  "raise exception 'native_result_binding_reverse_requires_empty_history';",
  String.raw`end if; end \$preflight\$;`,
  String.raw`drop function engineering_private\.admit_native_result_read_binding\(uuid,uuid,uuid,jsonb,text\);`,
  String.raw`drop table engineering_private\.native_result_read_bindings;`,
  "commit;$",
].join(" "));

describe("staged native result reader reverse source contract", () => {
  it("holds the exclusive history lock through owner/isolation/emptiness refusal and both drops", () => {
    expect(normalize(reverse)).toMatch(guardedReverse);
  });

  it("uses the same effective-owner and isolation contract as the pending reverse", () => {
    const condition = "current_user <> 'postgres' or current_setting('transaction_isolation') <> 'read committed'";
    expect(normalize(pendingReverse)).toContain(condition);
    expect(normalize(reverse)).toContain(condition);
    expect(normalize(forward)).toContain("if current_user<>'postgres' then raise exception 'native_result_binding_owner_required'");
  });

  it("targets the forward table and exact admission signature without changing the immutable history contract", () => {
    expect(normalize(forward)).toContain("create table engineering_private.native_result_read_bindings (");
    expect(normalize(forward)).toContain("create function engineering_private.admit_native_result_read_binding( p_task uuid,p_attempt uuid,p_evidence uuid,p_filesystem jsonb,p_qualification_sha256 text)");
    expect(normalize(forward)).toContain("create trigger native_result_read_binding_immutable before update or delete on engineering_private.native_result_read_bindings");
  });

  const lock = "lock table engineering_private.native_result_read_bindings in access exclusive mode;";
  const drop = "drop table engineering_private.native_result_read_bindings;";
  const mutations = [
    ["original unguarded reverse", () => `begin; drop function engineering_private.admit_native_result_read_binding(uuid,uuid,uuid,jsonb,text); ${drop} commit;`],
    ["missing lock", (sql) => sql.replace(lock, "")],
    ["weaker lock", (sql) => sql.replace("access exclusive", "access share")],
    ["wrong locked history", (sql) => sql.replace(lock, lock.replace("native_result_read_bindings", "native_pending_finalizations"))],
    ["unbounded lock wait", (sql) => sql.replace("lock_timeout = '5s'", "lock_timeout = '0'")],
    ["unbounded statement", (sql) => sql.replace("statement_timeout = '30s'", "statement_timeout = '0'")],
    ["missing owner refusal", (sql) => sql.replace("current_user <> 'postgres' or ", "")],
    ["login user instead of effective role", (sql) => sql.replace("current_user", "session_user")],
    ["missing isolation refusal", (sql) => sql.replace(" or current_setting('transaction_isolation') <> 'read committed'", "")],
    ["all refusal conditions required", (sql) => sql.replace(" or exists", " and exists")],
    ["inverted history refusal", (sql) => sql.replace("or exists", "or not exists")],
    ["missing history refusal", (sql) => sql.replace("or exists (select 1 from engineering_private.native_result_read_bindings)", "")],
    ["refusal downgraded to notice", (sql) => sql.replace("raise exception", "raise notice")],
    ["lock after preflight", (sql) => sql.replace(lock, "").replace("end $preflight$;", `end $preflight$; ${lock}`)],
    ["drop before guard", (sql) => sql.replace(drop, "").replace("begin;", `begin; ${drop}`)],
    ["commit releases lock before drop", (sql) => sql.replace(drop, `commit; ${drop}`)],
    ["guard only in comments", (sql) => sql.split("\n").map((line) => `-- ${line}`).join("\n") + `\nbegin; ${drop} commit;`],
  ];

  it.each(mutations)("the source check rejects %s", (_name, mutate) => {
    const changed = mutate(reverse);
    expect(changed).not.toBe(reverse);
    expect(normalize(changed)).not.toMatch(guardedReverse);
  });
});
