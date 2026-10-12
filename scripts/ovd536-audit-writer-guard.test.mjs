import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION = "supabase/migrations/20261003150000_ovd536_restrict_audit_event_writer.sql";
const FAILURE_TEST = "supabase/tests/ovd536_audit_writer_guard_failure.sql";
const TAG = "$ovd536_guard$";

function guardStatement(sql) {
  const start = sql.indexOf(`do ${TAG}`);
  const close = sql.indexOf(TAG, start + `do ${TAG}`.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(start);
  return sql.slice(start, close + TAG.length);
}

function executableStatements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

describe("OVD-536 audit-writer guard migration", () => {
  const migration = readFileSync(MIGRATION, "utf8");

  it("is a single DO statement so a guard failure rolls back the revoke under any runner", () => {
    const statement = guardStatement(migration);
    expect(executableStatements(migration)).toBe(`${statement};`);
    expect(statement.indexOf("revoke all on function public.log_audit_event"))
      .toBeLessThan(statement.indexOf("raise exception"));
  });

  it("is replayed byte-for-byte by the failure-path pgTAP test", () => {
    const failureTest = readFileSync(FAILURE_TEST, "utf8");
    expect(failureTest).toContain(`$ovd536_replay$\n${guardStatement(migration)}\n$ovd536_replay$`);
  });
});
