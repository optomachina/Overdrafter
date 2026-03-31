/**
 * Integration tests for the api_request_quote Postgres RPC.
 *
 * These tests require a running local Supabase instance with seed data loaded.
 * Run: npm run db:start && npm run seed:dev
 *
 * Runs in the node environment (matched by scripts/**\/*.test.mjs in vite.config.ts).
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Credential resolution — mirrors scripts/seed-dev.mjs
// ---------------------------------------------------------------------------

function resolveLocalCredentials() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.API_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY;

  if (supabaseUrl && serviceRoleKey) {
    return { supabaseUrl, serviceRoleKey };
  }

  let output;

  try {
    output = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    return null;
  }

  const parsed = {};

  for (const line of output.split("\n")) {
    const match = line.match(/^(\w+)="([^"]*)"$/);
    if (match) {
      parsed[match[1]] = match[2];
    }
  }

  const url = parsed["API_URL"];
  const key = parsed["SERVICE_ROLE_KEY"];

  if (!url || !key) {
    return null;
  }

  return { supabaseUrl: url, serviceRoleKey: key };
}

// ---------------------------------------------------------------------------
// Test constants — deterministic IDs matching scripts/seed-dev.mjs
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_EMAIL = "client.demo@overdrafter.local";
const CLIENT_PASSWORD = "Overdrafter123!";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a minimal job owned by the signed-in user via service role. */
async function insertTestJob(admin, userId, overrides = {}) {
  const { data, error } = await admin
    .from("jobs")
    .insert({
      organization_id: ORG_ID,
      created_by: userId,
      title: "Integration test job",
      status: "ready_to_quote",
      source: "client_home",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      requested_quote_quantities: [10],
      ...overrides,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`insertTestJob failed: ${error.message}`);
  }

  return data.id;
}

/** Insert a part row for a job. */
async function insertTestPart(admin, jobId, overrides = {}) {
  const { data, error } = await admin
    .from("parts")
    .insert({
      job_id: jobId,
      organization_id: ORG_ID,
      name: "Test part",
      normalized_key: "test-part",
      quantity: 10,
      ...overrides,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`insertTestPart failed: ${error.message}`);
  }

  return data.id;
}

/** Insert a job file (CAD) row. */
async function insertTestCadFile(admin, jobId, uploadedBy) {
  const { data, error } = await admin
    .from("job_files")
    .insert({
      job_id: jobId,
      organization_id: ORG_ID,
      file_kind: "cad",
      blob_id: null,
      storage_bucket: "job-files",
      storage_path: "test/test.step",
      normalized_name: "test.step",
      original_name: "test.step",
      size_bytes: 100,
      mime_type: "application/step",
      content_sha256: "deadbeef",
      uploaded_by: uploadedBy,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`insertTestCadFile failed: ${error.message}`);
  }

  return data.id;
}

/** Link a CAD file to a part. */
async function linkCadFileToPart(admin, partId, cadFileId) {
  const { error } = await admin
    .from("parts")
    .update({ cad_file_id: cadFileId })
    .eq("id", partId);

  if (error) {
    throw new Error(`linkCadFileToPart failed: ${error.message}`);
  }
}

/** Insert an approved_part_requirements row. */
async function insertTestRequirement(admin, partId, approvedBy, overrides = {}) {
  const { data, error } = await admin
    .from("approved_part_requirements")
    .insert({
      part_id: partId,
      organization_id: ORG_ID,
      approved_by: approvedBy,
      description: "Test part",
      part_number: "TEST-001",
      revision: "A",
      material: "6061-T6",
      quantity: 10,
      quote_quantities: [10],
      applicable_vendors: ["xometry"],
      spec_snapshot: {},
      ...overrides,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`insertTestRequirement failed: ${error.message}`);
  }

  return data.id;
}

/** Delete all rows created for a test job (cascade order). */
async function cleanupTestJob(admin, jobId) {
  // Delete in dependency order — work_queue → vendor_quote_results → quote_runs →
  // quote_requests → approved_part_requirements → parts → job_files → jobs
  await admin.from("work_queue").delete().eq("job_id", jobId);
  await admin.from("vendor_quote_results").delete().eq(
    "quote_run_id",
    admin.from("quote_runs").select("id").eq("job_id", jobId),
  );

  const { data: runs } = await admin.from("quote_runs").select("id").eq("job_id", jobId);
  if (runs?.length) {
    await admin
      .from("vendor_quote_results")
      .delete()
      .in(
        "quote_run_id",
        runs.map((r) => r.id),
      );
  }

  await admin.from("quote_runs").delete().eq("job_id", jobId);
  await admin.from("quote_requests").delete().eq("job_id", jobId);

  const { data: parts } = await admin.from("parts").select("id").eq("job_id", jobId);
  if (parts?.length) {
    await admin
      .from("approved_part_requirements")
      .delete()
      .in(
        "part_id",
        parts.map((p) => p.id),
      );
  }

  await admin.from("parts").delete().eq("job_id", jobId);
  await admin.from("job_files").delete().eq("job_id", jobId);
  await admin.from("jobs").delete().eq("id", jobId);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("api_request_quote gating paths", () => {
  const creds = resolveLocalCredentials();

  if (!creds) {
    it.skip("local Supabase is not running — start it with: npm run db:start", () => {});
    return;
  }

  const { supabaseUrl, serviceRoleKey } = creds;

  let admin;
  let client;
  let clientUserId;
  let testJobId;

  beforeAll(async () => {
    admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    client = createClient(supabaseUrl, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await client.auth.signInWithPassword({
      email: CLIENT_EMAIL,
      password: CLIENT_PASSWORD,
    });

    if (error) {
      throw new Error(`Could not sign in as test client: ${error.message}`);
    }

    clientUserId = data.user.id;
  });

  afterEach(async () => {
    if (testJobId) {
      await cleanupTestJob(admin, testJobId);
      testJobId = null;
    }
  });

  /** Call api_request_quote via the authenticated client session. */
  async function requestQuote(jobId, forceRetry = false) {
    const { data, error } = await client.rpc("api_request_quote", {
      p_job_id: jobId,
      p_force_retry: forceRetry,
    });

    return { data, error };
  }

  /** Build a fully quote-ready job: job + part + CAD + requirement. */
  async function buildQuoteReadyJob(jobOverrides = {}) {
    const jobId = await insertTestJob(admin, clientUserId, jobOverrides);
    const partId = await insertTestPart(admin, jobId);
    const cadFileId = await insertTestCadFile(admin, jobId, clientUserId);
    await linkCadFileToPart(admin, partId, cadFileId);
    await insertTestRequirement(admin, partId, clientUserId);
    return { jobId, partId, cadFileId };
  }

  it("accepts and creates a new quote request for a fully ready job", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const { data, error } = await requestQuote(jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(true);
    expect(data.created).toBe(true);
    expect(data.status).toBe("queued");
    expect(data.reasonCode).toBeNull();
    expect(data.quoteRequestId).toBeTruthy();
  });

  it("deduplicates and returns already_in_progress when a queued request exists", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    // First call creates the request
    await requestQuote(jobId);

    // Second call should deduplicate
    const { data, error } = await requestQuote(jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(true);
    expect(data.created).toBe(false);
    expect(data.deduplicated).toBe(true);
    expect(data.reasonCode).toBe("already_in_progress");
  });

  it("rejects with already_received when the job is in a completed quote state", async () => {
    // Use the pre-seeded published job which is in 'published' status
    // (no teardown needed since we're reading, not writing)
    const publishedJobId = "00000000-0000-4000-8000-000000000103";

    const { data, error } = await requestQuote(publishedJobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("already_received");
  });

  it("rejects with retry_required when the prior request failed and force_retry is false", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    // Manually insert a failed quote request so we can test this gate
    await admin.from("quote_requests").insert({
      organization_id: ORG_ID,
      job_id: jobId,
      requested_by: clientUserId,
      requested_vendors: ["xometry"],
      status: "failed",
      failure_reason: "Xometry quote timed out.",
    });

    const { data, error } = await requestQuote(jobId, false);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("retry_required");
  });

  it("accepts a retry when force_retry is true after a failed request", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    // Manually insert a failed quote request
    await admin.from("quote_requests").insert({
      organization_id: ORG_ID,
      job_id: jobId,
      requested_by: clientUserId,
      requested_vendors: ["xometry"],
      status: "failed",
      failure_reason: "Xometry quote timed out.",
    });

    const { data, error } = await requestQuote(jobId, true);

    expect(error).toBeNull();
    expect(data.accepted).toBe(true);
    expect(data.created).toBe(true);
    expect(data.status).toBe("queued");
  });

  it("rejects with archived when the job is archived", async () => {
    const { jobId } = await buildQuoteReadyJob({
      archived_at: new Date().toISOString(),
    });
    testJobId = jobId;

    const { data, error } = await requestQuote(jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("archived");
  });

  it("rejects with missing_part when the job has no part rows", async () => {
    const jobId = await insertTestJob(admin, clientUserId);
    testJobId = jobId;

    const { data, error } = await requestQuote(jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("missing_part");
  });

  it("rejects with missing_cad when the part has no CAD file", async () => {
    const jobId = await insertTestJob(admin, clientUserId);
    testJobId = jobId;
    const partId = await insertTestPart(admin, jobId); // no CAD linked
    await insertTestRequirement(admin, partId, clientUserId);

    const { data, error } = await requestQuote(jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("missing_cad");
  });

  it("rejects with missing_requirements when the part has no approved requirement", async () => {
    const jobId = await insertTestJob(admin, clientUserId);
    testJobId = jobId;
    const partId = await insertTestPart(admin, jobId);
    const cadFileId = await insertTestCadFile(admin, jobId, clientUserId);
    await linkCadFileToPart(admin, partId, cadFileId);
    // No requirement inserted

    const { data, error } = await requestQuote(jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("missing_requirements");
  });

  it("rejects with no_enabled_vendors when applicable_vendors is empty", async () => {
    const jobId = await insertTestJob(admin, clientUserId);
    testJobId = jobId;
    const partId = await insertTestPart(admin, jobId);
    const cadFileId = await insertTestCadFile(admin, jobId, clientUserId);
    await linkCadFileToPart(admin, partId, cadFileId);
    await insertTestRequirement(admin, partId, clientUserId, { applicable_vendors: [] });

    const { data, error } = await requestQuote(jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    // The RPC returns 'no_enabled_vendors' when applicable_vendors is empty
    // (the multi-vendor migration replaced the earlier 'xometry_unavailable' code)
    expect(data.reasonCode).toBe("no_enabled_vendors");
  });
});
