// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260815093000_enforce_founding_beta_file_boundaries.sql",
  "utf8",
)
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("Founding Beta file-boundary migration", () => {
  it("uses one stable access-state guard for every file RPC", () => {
    expect(sql).toContain("create or replace function private.require_current_founding_beta_file_access");
    expect(sql).toContain("private.resolve_founding_beta_access_state");
    expect(sql).toContain("message = 'founding_beta_' || coalesce(v_state, 'not_enrolled')");
    expect(sql).toContain("'prepare'");
    expect(sql).toContain("'finalize'");
    expect(sql).toContain("'legacy_attach'");
  });

  it("gates direct metadata and both storage-path families", () => {
    expect(sql).toContain('drop policy if exists "job_files_insert_members"');
    expect(sql).not.toContain('create policy "job_files_insert_members"');
    expect(sql).toContain("revoke insert on public.job_files from authenticated");
    expect(sql).toContain('create policy "job_files_storage_insert"');
    expect(sql).toContain("name ~ '^org-sha256/[0-9a-f-]{36}/[0-9a-f]{64}/[a-z0-9._-]+$'");
    expect(sql).not.toContain("job.id::text = split_part(name, '/', 1)");
    expect(sql).toContain("public.current_user_has_current_founding_beta_access(job.organization_id)");
  });

  it("binds finalization to the server-derived bucket, path, and object", () => {
    expect(sql).toContain("v_expected_path := public.build_org_file_blob_storage_path");
    expect(sql).toContain("p_storage_bucket is distinct from 'job-files'");
    expect(sql).toContain("p_storage_path is distinct from v_expected_path");
    expect(sql).toContain("from storage.objects object_row");
    expect(sql).toContain("message = 'file_upload_path_mismatch'");
    expect(sql).toContain("message = 'file_upload_object_missing'");
  });

  it("retires arbitrary-path legacy attachment without changing read or delete policies", () => {
    expect(sql).toContain("message = 'legacy_file_attach_unavailable'");
    expect(sql).not.toContain('drop policy if exists "job_files_select_members"');
    expect(sql).not.toContain('drop policy if exists "job_files_delete_internal"');
    expect(sql).not.toContain('drop policy if exists "job_files_storage_read"');
  });

  it("logs only bounded denial reasons and requires canonical hashes", () => {
    expect(sql).toContain("founding beta file write denied: state=%, boundary=%");
    expect(sql).toContain("founding beta file finalize denied: reason=canonical_path_mismatch");
    expect(sql).toContain("v_normalized_hash !~ '^[0-9a-f]{64}$'");
    expect(sql).not.toContain("raise log '%, %, %'");
  });
});
