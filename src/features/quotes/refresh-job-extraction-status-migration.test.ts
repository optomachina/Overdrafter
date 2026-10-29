import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const filename = "20261025194414_ovd1097_refresh_job_extraction_status.sql";
const sql = readFileSync(path.join(root, "supabase/migrations", filename), "utf8");
const body = sql.split("as $$")[1].split("$$;")[0];
const signature = "public.api_refresh_job_extraction_status(uuid)";

describe("OVD-1097 extraction status refresh migration", () => {
  it("B11: exposes a pinned SECURITY DEFINER function only to service_role", () => {
    expect(sql).toMatch(/returns text\s+language plpgsql\s+security definer\s+set search_path = pg_catalog/i);
    expect(sql).toContain(`revoke execute on function ${signature} from public;`);
    expect(sql).toContain(`revoke execute on function ${signature} from anon, authenticated;`);
    expect(sql).toContain(`grant execute on function ${signature} to service_role;`);
  });

  it("F1/F3: locks the job and considers only each part's newest extraction and real files", () => {
    expect(body).toMatch(/from public.jobs\s+where id = p_job_id\s+for update/i);
    expect(body).toContain("if v_job.status <> 'extracting' then");
    expect(body).toContain("distinct on (queue.part_id)");
    expect(body).toContain("queue.task_type = 'extract_part'");
    expect(body).toContain("order by queue.part_id, queue.created_at desc, queue.id desc");
    expect(body).toContain("part.cad_file_id is not null or part.drawing_file_id is not null");
    expect(body).toContain("elsif v_file_parts > 0 and v_unapproved = 0 then");
    expect(body).not.toMatch(/(?:insert into|update|delete from) public.approved_part_requirements/i);
  });

  it("provides the exact down path outside the forward migration tree", () => {
    const drop = `drop function ${signature};`;
    expect(sql).toContain(`--   ${drop}`);
    const rollback = readFileSync(path.join(root, "docs/migration-drafts/ovd-1097.rollback.sql"), "utf8");
    expect(rollback.replace(/--[^\n]*/g, "").trim()).toBe(drop);
    expect(readdirSync(path.join(root, "docs/migration-drafts")).filter((name) => /ovd-?1097/.test(name)))
      .toEqual(["ovd-1097.rollback.sql"]);
    const earlier = readdirSync(path.join(root, "supabase/migrations")).filter((name) => name !== filename);
    expect(earlier.every((name) => name < filename)).toBe(true);
  });
});
