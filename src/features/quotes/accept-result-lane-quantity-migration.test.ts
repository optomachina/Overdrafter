// @vitest-environment node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const filename = "20261101130400_ovd1000_accept_result_lane_quantity.sql";
const migration = readFileSync(`supabase/migrations/${filename}`, "utf8");
const previous = readFileSync("supabase/migrations/20261029165751_reconcile_claim_fence.sql", "utf8");
const rollback = readFileSync("docs/migration-drafts/ovd-1000.rollback.sql", "utf8");
const signature = "public.accept_vendor_quote_result(uuid,text,timestamptz,integer,uuid,jsonb,jsonb,jsonb)";
const head = "public.accept_vendor_quote_result(\n";
const definition = (sql: string) => {
  const start = sql.indexOf(`function ${head}`);
  const grant = `grant execute on function ${signature} to service_role;\n`;
  return sql.slice(start, sql.indexOf(grant, start) + grant.length);
};
const body = (sql: string) => definition(sql).split("as $$")[1].split("$$;")[0];
const md5 = (sql: string) => createHash("md5").update(body(sql)).digest("hex");

const literalOne = `            quote_run_id, part_id, provider, 1 requested_quantity, quote_request_id, quote_request_lane_id
          from private.xometry_beta_dispatch_permits
`;
const laneQuantity = `            quote_run_id, part_id, provider,
            (select xometry_lane.requested_quantity from public.quote_request_lanes xometry_lane
              where xometry_lane.id = xometry_permit.quote_request_lane_id) requested_quantity,
            quote_request_id, quote_request_lane_id
          from private.xometry_beta_dispatch_permits xometry_permit
`;

describe("OVD-1000 fenced acceptance takes the Xometry permit quantity from its lane", () => {
  it("guards on the reconcile-claim-fence body and changes only the literal quantity", () => {
    expect(md5(previous)).toBe("c72d8ca87d6da4d3ae0448497b14e52f");
    expect(md5(migration)).toBe("c79ef7028326dbe470428af844af1bbd");
    expect(migration).toContain("not in ('c72d8ca87d6da4d3ae0448497b14e52f', 'c79ef7028326dbe470428af844af1bbd')");
    expect(body(migration)).not.toContain("1 requested_quantity");
    expect(body(previous).split(literalOne)).toHaveLength(2);
    expect(body(migration)).toBe(body(previous).replace(literalOne, laneQuantity));
  });

  it("restates the security attributes, revoke and grant byte for byte", () => {
    const restated = definition(previous).replace("create function", "create or replace function");
    expect(definition(migration).replace(laneQuantity, literalOne)).toBe(restated);
    expect(definition(migration)).toContain(
      "returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$",
    );
    expect(definition(migration)).toContain(`revoke all on function ${signature}\nfrom public, anon, authenticated;`);
  });

  it("rolls back to the previous body exactly, behind its own md5 guard", () => {
    expect(md5(rollback)).toBe("c72d8ca87d6da4d3ae0448497b14e52f");
    expect(definition(rollback)).toBe(definition(previous).replace("create function", "create or replace function"));
    expect(rollback).toContain("not in ('c79ef7028326dbe470428af844af1bbd', 'c72d8ca87d6da4d3ae0448497b14e52f')");
  });

  it("is the newest definition of the function", () => {
    const newer = readdirSync("supabase/migrations").filter((name) => name > filename);
    expect(newer.filter((name) => readFileSync(`supabase/migrations/${name}`, "utf8").includes(head))).toEqual([]);
  });
});
