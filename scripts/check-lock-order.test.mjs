import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KNOWN_INVERSIONS,
  LockOrderError,
  audit,
  findInversions,
  latestDefinitions,
  lockSequence,
  unauditedCallees,
  verify,
} from "./check-lock-order.mjs";

const fn = (name, body) =>
  `create or replace function public.${name}(p_job_id uuid) returns void language plpgsql as $$\nbegin\n${body}\nend;\n$$;\n`;

const migrations = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "lock-order-"));
  for (const [file, sql] of Object.entries(files))
    writeFileSync(join(dir, file), sql);
  return dir;
};

const tables = (locks) => locks.map((l) => `${l.level}:${l.table}`);

describe("check-lock-order", () => {
  it("orders FOR UPDATE, UPDATE, DELETE and advisory locks by source position", () => {
    const locks = lockSequence(`
      perform pg_advisory_xact_lock(hashtext('ovd979:job:' || p_job_id::text));
      select 1 from public.jobs where id = p_job_id for no key update;
      -- update public.work_queue set status = 'x'; (comment, ignored)
      update public.parts set name = 'update work_queue' where job_id = p_job_id;
      delete from public.drawing_extractions where part_id = p_job_id;`);
    expect(tables(locks)).toEqual([
      "0:advisory",
      "1:jobs",
      "2:parts",
      "4:drawing_extractions",
    ]);
    expect(findInversions(locks)).toEqual([]);
  });

  it("reports every inversion pair", () => {
    const locks = lockSequence(`
      update public.drawing_extractions set x = 1;
      update public.parts set name = 'a';
      update public.jobs set status = 'x';`);
    expect(findInversions(locks)).toEqual([
      "drawing_extractions > jobs",
      "drawing_extractions > parts",
    ]);
  });

  it("(1) errors on an unparsable latest definition instead of using an older one", () => {
    const dir = migrations({
      "001.sql": fn(
        "api_approve_job_requirements",
        "update public.jobs set a = 1;",
      ),
      "002.sql":
        "create or replace function public.api_approve_job_requirements(p uuid) returns void language sql;\n",
    });
    expect(() => latestDefinitions(dir)).toThrow(LockOrderError);
    expect(() => latestDefinitions(dir)).toThrow(/002\.sql: cannot parse/);
  });

  it("(2) errors on a lock on a table outside the order", () => {
    for (const sql of [
      "update public.quote_runs set a = 1;",
      "select 1 from public.quote_runs for update;",
      "insert into public.quote_runs (a) values (1);",
      "delete from public.quote_runs;",
    ])
      expect(() => lockSequence(sql)).toThrow(
        /"quote_runs" outside the canonical order/,
      );
  });

  it("(3) resolves FOR UPDATE OF <alias> through joins and attributes subquery locks", () => {
    expect(
      tables(
        lockSequence(`
          select p.id into v from public.jobs j
            join public.parts p on p.job_id = j.id
            where j.id = p_job_id for update of p;`),
      ),
    ).toEqual(["2:parts"]);
    expect(
      tables(
        lockSequence(`
          select j.id from public.jobs j join public.parts as p on p.job_id = j.id for update;`),
      ),
    ).toEqual(["1:jobs", "2:parts"]);
    expect(
      tables(
        lockSequence(`
          update public.jobs set status = 'x' where id in (
            select w.job_id from public.work_queue w where w.status = 'queued' for update skip locked);`),
      ),
    ).toEqual(["1:jobs", "5:work_queue"]);
    expect(() =>
      lockSequence("select 1 from public.jobs j for update of q;"),
    ).toThrow(/cannot resolve FOR \.\.\. OF q/);
    expect(() => lockSequence("select 1 for update;")).toThrow(
      /cannot resolve the table locked/,
    );
  });

  it("(4) counts INSERT and INSERT ... ON CONFLICT DO UPDATE as lock steps", () => {
    const locks = lockSequence(`
      insert into public.approved_part_requirements (part_id) values (p_job_id)
        on conflict (part_id) do update set part_id = excluded.part_id;
      insert into public.work_queue (task_type) values ('extract_part');
      update public.jobs set status = 'x';`);
    expect(locks.map((l) => `${l.table}(${l.kind})`)).toEqual([
      "approved_part_requirements(insert)",
      "work_queue(insert)",
      "jobs(update)",
    ]);
    expect(findInversions(locks)).toEqual(["work_queue > jobs"]);
  });

  it("(5) a new inversion pair in a listed function fails; a vanished pair fails", () => {
    const row = (inversions) => ({
      name: "api_approve_job_requirements",
      locks: [],
      inversions,
      unauditedCalls: [],
    });
    const known = {
      api_approve_job_requirements: ["drawing_extractions > jobs"],
    };
    expect(
      verify([row(["drawing_extractions > jobs"])], known, {}, {}),
    ).toEqual([]);
    expect(
      verify(
        [row(["drawing_extractions > jobs", "work_queue > parts"])],
        known,
        {},
        {},
      ),
    ).toEqual([
      "api_approve_job_requirements: unlisted inversion work_queue > parts",
    ]);
    expect(verify([row([])], known, {}, {})[0]).toMatch(/no longer occurs/);
  });

  it("errors when callee expansion hits the depth cap", () => {
    const loop = fn(
      "api_reconcile_job_parts",
      "perform public.api_reconcile_job_parts(p_job_id);",
    );
    const dir = migrations({ "001.sql": loop });
    expect(() => audit(dir)).toThrow(/depth cap of 3/);
  });

  it("uses the latest definition and expands audited callees at the call site", () => {
    const dir = migrations({
      "001.sql": fn(
        "api_approve_job_requirements",
        "update public.parts set name = 'a';\nupdate public.jobs set status = 'x';",
      ),
      "002.sql": fn(
        "api_approve_job_requirements",
        "update public.jobs set status = 'x';\nupdate public.parts set name = 'a';",
      ),
      "003.sql": fn(
        "api_reconcile_job_parts",
        "delete from public.parts where job_id = p_job_id;",
      ),
      "004.sql": fn(
        "api_request_extraction",
        "perform public.api_reconcile_job_parts(p_job_id);\nupdate public.jobs set status = 'x';",
      ),
    });
    expect(
      latestDefinitions(dir).get("api_approve_job_requirements").file,
    ).toBe("002.sql");
    const rows = Object.fromEntries(audit(dir).map((row) => [row.name, row]));
    expect(rows.api_approve_job_requirements.inversions).toEqual([]);
    expect(rows.api_request_extraction.locks[0]).toMatchObject({
      table: "parts",
      via: "api_reconcile_job_parts",
    });
    expect(rows.api_request_extraction.inversions).toEqual(["parts > jobs"]);
  });

  it("can be imported without a CLI argv (main block is guarded)", async () => {
    const saved = process.argv;
    process.argv = [process.argv[0]];
    try {
      await expect(
        import("./check-lock-order.mjs?argvless"),
      ).resolves.toBeTruthy();
    } finally {
      process.argv = saved;
    }
  });

  it("matches the repository exactly, independent of the working directory", () => {
    const cwd = process.cwd();
    process.chdir(tmpdir());
    try {
      const rows = audit();
      expect(rows.filter((row) => row.missing).map((row) => row.name)).toEqual(
        [],
      );
      expect(verify(rows)).toEqual([]);
      const inverted = Object.fromEntries(
        rows
          .filter((row) => row.inversions.length)
          .map((row) => [row.name, row.inversions]),
      );
      expect(inverted).toEqual(
        Object.fromEntries(
          Object.entries(KNOWN_INVERSIONS).map(([k, v]) => [k, [...v].sort()]),
        ),
      );
    } finally {
      process.chdir(cwd);
    }
  });

  describe("Opus round-2 regressions", () => {
    it("latest-definition scan: a single-quoted latest body is an error, not the next function's body", () => {
      const dir = migrations({
        "001.sql": fn(
          "api_approve_job_requirements",
          "update public.jobs set a = 1;",
        ),
        "002.sql":
          "create or replace function public.api_approve_job_requirements(p uuid) returns void language sql as 'update public.parts set a = 1';\n" +
          fn("other_helper", "update public.work_queue set a = 1;"),
      });
      expect(() => latestDefinitions(dir)).toThrow(
        /002\.sql: cannot parse function body/,
      );
    });

    it("latest-definition scan: a BEGIN ATOMIC latest body is an error", () => {
      const dir = migrations({
        "001.sql": fn(
          "api_approve_job_requirements",
          "update public.jobs set a = 1;",
        ),
        "002.sql":
          "create or replace function public.api_approve_job_requirements(p uuid) returns void language sql begin atomic update public.parts set a = 1; end;\n" +
          fn("other_helper", "update public.work_queue set a = 1;"),
      });
      expect(() => latestDefinitions(dir)).toThrow(
        /002\.sql: cannot parse function body/,
      );
    });

    it("latest-definition scan: a commented-out header doesn't take the next function's body", () => {
      const dir = migrations({
        "001.sql": fn(
          "api_approve_job_requirements",
          "update public.jobs set a = 1;",
        ),
        "002.sql":
          "-- create or replace function public.api_approve_job_requirements(\n/* create function api_approve_job_requirements( */\n" +
          fn("other_helper", "update public.work_queue set a = 1;"),
      });
      const def = latestDefinitions(dir).get("api_approve_job_requirements");
      expect(def.file).toBe("001.sql");
      expect(def.body).not.toMatch(/work_queue/);
    });

    it("a bare JOIN after an unaliased table is not read as an alias", () => {
      expect(
        tables(
          lockSequence(
            "select 1 from public.jobs join public.parts p on p.job_id = jobs.id for update;",
          ),
        ),
      ).toEqual(["1:jobs", "2:parts"]);
      expect(
        tables(
          lockSequence(
            "select 1 from public.jobs inner join public.parts on parts.job_id = jobs.id for update of parts;",
          ),
        ),
      ).toEqual(["2:parts"]);
    });

    it("comma-separated FROM lists register every table", () => {
      expect(
        tables(
          lockSequence(
            "select 1 from public.jobs j, public.parts p where p.job_id = j.id for update;",
          ),
        ),
      ).toEqual(["1:jobs", "2:parts"]);
      expect(
        tables(
          lockSequence(
            "select 1 from public.jobs j, public.parts p for update of p;",
          ),
        ),
      ).toEqual(["2:parts"]);
      expect(() =>
        lockSequence(
          "select 1 from public.jobs j, public.quote_runs q for update;",
        ),
      ).toThrow(/"quote_runs" outside the canonical order/);
    });

    it("LOCK TABLE is a lock step, and an error outside the order", () => {
      expect(
        tables(
          lockSequence(
            "lock table public.jobs in share row exclusive mode;\nlock public.work_queue, only public.parts nowait;",
          ),
        ),
      ).toEqual(["1:jobs", "5:work_queue", "2:parts"]);
      expect(() =>
        lockSequence("lock table public.quote_runs in exclusive mode;"),
      ).toThrow(/"quote_runs" outside the canonical order/);
    });

    it("expands every call to the same callee in one statement", () => {
      const defs = new Map([
        [
          "api_reconcile_job_parts",
          { body: "delete from public.parts where id = p;" },
        ],
      ]);
      const locks = lockSequence(
        "select public.api_reconcile_job_parts(a), public.api_reconcile_job_parts(b);",
        defs,
      );
      expect(locks.map((l) => `${l.table}[${l.via}]`)).toEqual([
        "parts[api_reconcile_job_parts]",
        "parts[api_reconcile_job_parts]",
      ]);
    });

    it("calls outside the audited list must be listed exactly and take no ordered lock", () => {
      const dir = migrations({
        "001.sql":
          fn("log_helper", "insert into public.audit_events (a) values (1);") +
          fn("bad_helper", "update public.jobs set a = 1;") +
          fn(
            "api_claim_next_task",
            "perform public.log_helper(p_job_id);\nperform public.bad_helper(p_job_id);",
          ),
      });
      const row = audit(dir).find((r) => r.name === "api_claim_next_task");
      expect(row.unauditedCalls).toEqual(["bad_helper", "log_helper"]);
      expect(row.unauditedOrderedLocks).toEqual(["bad_helper: jobs"]);
      const errors = verify(
        [row],
        {},
        {},
        { api_claim_next_task: ["log_helper"] },
      );
      expect(errors).toEqual([
        "api_claim_next_task: unaudited callee locks an ordered table (bad_helper: jobs); add the callee to AUDITED_FUNCTIONS",
        "api_claim_next_task: unaudited callees [bad_helper, log_helper] don't match KNOWN_UNAUDITED_CALLEES [log_helper]",
      ]);
      expect(
        unauditedCallees(
          "select 'log_helper(' ;",
          new Map([["log_helper", {}]]),
        ),
      ).toEqual([]);
    });

    it("stale or misspelled keys in the known lists fail", () => {
      expect(verify([], { api_aprove_job_requirements: [] }, {}, {})).toEqual([
        "KNOWN_INVERSIONS: key api_aprove_job_requirements is not an audited function",
      ]);
      expect(verify([], {}, { not_a_function: ["job_files"] }, {})).toEqual([
        "KNOWN_UNORDERED_LOCKS: key not_a_function is not an audited function",
      ]);
      expect(verify([], {}, {}, { nope: [] })).toEqual([
        "KNOWN_UNAUDITED_CALLEES: key nope is not an audited function",
      ]);
    });

    it("a vanished KNOWN_UNORDERED_LOCKS entry fails, and a table listed for one function is rejected in another", () => {
      const row = {
        name: "api_reconcile_job_parts",
        locks: [{ table: "parts", level: 2, kind: "delete" }],
        inversions: [],
        unauditedCalls: [],
      };
      expect(
        verify([row], {}, { api_reconcile_job_parts: ["job_files"] }, {}),
      ).toEqual([
        "api_reconcile_job_parts: listed unordered lock on job_files no longer occurs; remove it from KNOWN_UNORDERED_LOCKS",
      ]);
      expect(
        lockSequence(
          "update public.job_files set a = 1;",
          new Map(),
          0,
          "api_reconcile_job_parts",
        )[0].level,
      ).toBeNull();
      expect(() =>
        lockSequence(
          "update public.job_files set a = 1;",
          new Map(),
          0,
          "api_claim_next_task",
        ),
      ).toThrow(/"job_files" outside the canonical order/);
    });
  });
});
