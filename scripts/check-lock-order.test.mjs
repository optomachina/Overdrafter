import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KNOWN_INVERSIONS,
  audit,
  findInversion,
  latestDefinitions,
  lockSequence,
} from "./check-lock-order.mjs";

const fn = (name, body) =>
  `create or replace function public.${name}(p_job_id uuid) returns void language plpgsql as $$\nbegin\n${body}\nend;\n$$;\n`;

describe("check-lock-order", () => {
  it("orders FOR UPDATE, UPDATE, DELETE and advisory locks by source position", () => {
    const locks = lockSequence(`
      perform pg_advisory_xact_lock(hashtext('ovd979:job:' || p_job_id::text));
      select 1 from public.jobs where id = p_job_id for no key update;
      -- update public.work_queue set status = 'x'; (comment, ignored)
      update public.parts set name = 'a' where job_id = p_job_id;
      delete from public.drawing_extractions where part_id = p_job_id;`);
    expect(locks.map((l) => `${l.level}:${l.table}`)).toEqual([
      "0:advisory",
      "1:jobs",
      "2:parts",
      "4:drawing_extractions",
    ]);
    expect(findInversion(locks)).toBeNull();
  });

  it("flags a lower level taken after a higher one", () => {
    const locks = lockSequence(`
      update public.parts set name = 'a';
      update public.jobs set status = 'x';`);
    expect(findInversion(locks)).toEqual({ after: "parts", took: "jobs" });
  });

  it("uses the latest definition and expands audited callees at the call site", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-order-"));
    writeFileSync(
      join(dir, "001.sql"),
      fn(
        "api_approve_job_requirements",
        "update public.parts set name = 'a';\nupdate public.jobs set status = 'x';",
      ),
    );
    writeFileSync(
      join(dir, "002.sql"),
      fn(
        "api_approve_job_requirements",
        "update public.jobs set status = 'x';\nupdate public.parts set name = 'a';",
      ),
    );
    writeFileSync(
      join(dir, "003.sql"),
      fn(
        "api_reconcile_job_parts",
        "delete from public.parts where job_id = p_job_id;",
      ),
    );
    writeFileSync(
      join(dir, "004.sql"),
      fn(
        "api_request_extraction",
        "perform public.api_reconcile_job_parts(p_job_id);\nupdate public.jobs set status = 'x';",
      ),
    );
    const defs = latestDefinitions(dir);
    expect(defs.get("api_approve_job_requirements").file).toBe("002.sql");
    const rows = Object.fromEntries(audit(dir).map((row) => [row.name, row]));
    expect(rows.api_approve_job_requirements.inversion).toBeNull();
    expect(rows.api_request_extraction.locks[0]).toMatchObject({
      table: "parts",
      via: "api_reconcile_job_parts",
    });
    expect(rows.api_request_extraction.inversion).toEqual({
      after: "parts",
      took: "jobs",
    });
  });

  it("matches the repository: only the known inversions exist, and every known one still exists", () => {
    const rows = audit("supabase/migrations");
    expect(rows.filter((row) => row.missing).map((row) => row.name)).toEqual(
      [],
    );
    const inverted = rows
      .filter((row) => row.inversion)
      .map((row) => row.name)
      .sort();
    expect(inverted).toEqual(Object.keys(KNOWN_INVERSIONS).sort());
  });
});
