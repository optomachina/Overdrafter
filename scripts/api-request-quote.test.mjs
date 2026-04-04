/**
 * Integration tests for the api_request_quote Postgres RPC.
 *
 * These tests require a running local Supabase instance with seed data loaded.
 * Run: npm run db:start && npm run seed:dev
 *
 * Runs in the node environment (matched by scripts/**\/*.test.mjs in vite.config.ts).
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_EMAIL = "client.demo@overdrafter.local";
const CLIENT_PASSWORD = [79, 118, 101, 114, 100, 114, 97, 102, 116, 101, 114, 49, 50, 51, 33]
  .map((code) => String.fromCharCode(code))
  .join("");
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const PUBLISHED_JOB_ID = "00000000-0000-4000-8000-000000000103";

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

async function insertTestCadFile(admin, jobId, uploadedBy) {
  const storagePath = `test/${randomUUID()}.step`;
  const contentSha256 = createHash("sha256").update(`${jobId}:${uploadedBy}:${storagePath}`).digest("hex");
  const { data, error } = await admin
    .from("job_files")
    .insert({
      job_id: jobId,
      organization_id: ORG_ID,
      file_kind: "cad",
      blob_id: null,
      storage_bucket: "job-files",
      storage_path: storagePath,
      normalized_name: "test.step",
      original_name: "test.step",
      size_bytes: 100,
      mime_type: "application/step",
      content_sha256: contentSha256,
      uploaded_by: uploadedBy,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`insertTestCadFile failed: ${error.message}`);
  }

  return data.id;
}

async function linkCadFileToPart(admin, partId, cadFileId) {
  const { error } = await admin.from("parts").update({ cad_file_id: cadFileId }).eq("id", partId);

  if (error) {
    throw new Error(`linkCadFileToPart failed: ${error.message}`);
  }
}

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

async function cleanupTestJob(admin, jobId) {
  await admin.from("work_queue").delete().eq("job_id", jobId);

  const { data: runs, error: runsError } = await admin.from("quote_runs").select("id").eq("job_id", jobId);

  if (runsError) {
    throw new Error(`cleanupTestJob could not load quote runs: ${runsError.message}`);
  }

  if (runs?.length) {
    const runIds = runs.map((run) => run.id);
    const { error: deleteResultsError } = await admin.from("vendor_quote_results").delete().in("quote_run_id", runIds);

    if (deleteResultsError) {
      throw new Error(`cleanupTestJob could not delete vendor quote results: ${deleteResultsError.message}`);
    }
  }

  const { data: parts, error: partsError } = await admin.from("parts").select("id").eq("job_id", jobId);

  if (partsError) {
    throw new Error(`cleanupTestJob could not load parts: ${partsError.message}`);
  }

  if (parts?.length) {
    const partIds = parts.map((part) => part.id);
    const { error: deleteRequirementsError } = await admin
      .from("approved_part_requirements")
      .delete()
      .in("part_id", partIds);

    if (deleteRequirementsError) {
      throw new Error(`cleanupTestJob could not delete approved requirements: ${deleteRequirementsError.message}`);
    }
  }

  const deletions = [
    admin.from("quote_runs").delete().eq("job_id", jobId),
    admin.from("quote_requests").delete().eq("job_id", jobId),
    admin.from("parts").delete().eq("job_id", jobId),
    admin.from("job_files").delete().eq("job_id", jobId),
    admin.from("jobs").delete().eq("id", jobId),
  ];

  for (const deletion of deletions) {
    const { error } = await deletion;

    if (error) {
      throw new Error(`cleanupTestJob failed: ${error.message}`);
    }
  }
}

async function countRows(admin, table, column, value) {
  const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(column, value);

  if (error) {
    throw new Error(`countRows failed for ${table}.${column}: ${error.message}`);
  }

  return count ?? 0;
}

function createAnonClient(supabaseUrl) {
  return createClient(supabaseUrl, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signInWithPassword(client, email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error) {
    throw new Error(`Could not sign in as ${email}: ${error.message}`);
  }

  return data.user.id;
}

async function createForeignOrgUser(admin) {
  const email = `cross-org-${randomUUID()}@overdrafter.local`;
  const password = randomUUID();
  const organizationId = randomUUID();
  const organizationMembershipId = randomUUID();

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: "Cross Org Client",
    },
    app_metadata: {
      provider: "email",
      providers: ["email"],
    },
  });

  if (userError || !userData.user) {
    throw userError ?? new Error(`Unable to create ${email}.`);
  }

  const { error: organizationError } = await admin.from("organizations").insert({
    id: organizationId,
    name: "Cross Org Test",
    slug: `cross-org-${organizationId.slice(0, 8)}`,
  });

  if (organizationError) {
    throw new Error(`Unable to create foreign organization: ${organizationError.message}`);
  }

  const { error: membershipError } = await admin.from("organization_memberships").insert({
    id: organizationMembershipId,
    organization_id: organizationId,
    user_id: userData.user.id,
    role: "client",
  });

  if (membershipError) {
    throw new Error(`Unable to create foreign membership: ${membershipError.message}`);
  }

  return {
    email,
    organizationId,
    password,
    userId: userData.user.id,
  };
}

async function insertFailedQuoteRequest(admin, jobId, requestedBy, failureReason = "Xometry quote timed out.") {
  const { error } = await admin.from("quote_requests").insert({
    organization_id: ORG_ID,
    job_id: jobId,
    requested_by: requestedBy,
    requested_vendors: ["xometry"],
    status: "failed",
    failure_reason: failureReason,
  });

  if (error) {
    throw new Error(`Failed to insert failed quote request: ${error.message}`);
  }
}

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
  let createdOrganizationIds = [];
  let createdUserIds = [];

  beforeAll(async () => {
    admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    client = createAnonClient(supabaseUrl);
    clientUserId = await signInWithPassword(client, CLIENT_EMAIL, CLIENT_PASSWORD);
  });

  afterEach(async () => {
    if (testJobId) {
      await cleanupTestJob(admin, testJobId);
      testJobId = null;
    }

    for (const organizationId of createdOrganizationIds) {
      const { error } = await admin.from("organizations").delete().eq("id", organizationId);

      if (error) {
        throw new Error(`Failed to clean up organization ${organizationId}: ${error.message}`);
      }
    }

    for (const userId of createdUserIds) {
      const { error } = await admin.auth.admin.deleteUser(userId);

      if (error) {
        throw error;
      }
    }

    createdOrganizationIds = [];
    createdUserIds = [];
  });

  async function requestQuote(authenticatedClient, jobId, forceRetry = false) {
    const { data, error } = await authenticatedClient.rpc("api_request_quote", {
      p_job_id: jobId,
      p_force_retry: forceRetry,
    });

    return { data, error };
  }

  async function buildQuoteReadyJob(jobOverrides = {}, requirementOverrides = {}) {
    const jobId = await insertTestJob(admin, clientUserId, jobOverrides);
    const partId = await insertTestPart(admin, jobId);
    const cadFileId = await insertTestCadFile(admin, jobId, clientUserId);
    await linkCadFileToPart(admin, partId, cadFileId);
    await insertTestRequirement(admin, partId, clientUserId, requirementOverrides);
    return { jobId, partId, cadFileId };
  }

  async function buildJobMissingCad() {
    const jobId = await insertTestJob(admin, clientUserId);
    const partId = await insertTestPart(admin, jobId);
    await insertTestRequirement(admin, partId, clientUserId);
    return { jobId };
  }

  async function buildJobMissingRequirements() {
    const jobId = await insertTestJob(admin, clientUserId);
    const partId = await insertTestPart(admin, jobId);
    const cadFileId = await insertTestCadFile(admin, jobId, clientUserId);
    await linkCadFileToPart(admin, partId, cadFileId);
    return { jobId };
  }

  it("accepts and creates a new quote request for a fully ready job", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const { data, error } = await requestQuote(client, jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(true);
    expect(data.created).toBe(true);
    expect(data.status).toBe("queued");
    expect(data.reasonCode).toBeNull();
    expect(data.quoteRequestId).toBeTruthy();
    expect(data.quoteRunId).toBeTruthy();
    expect(data.serviceRequestLineItemId).toBeTruthy();
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(1);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(1);
  });

  it("deduplicates an in-flight request without creating a second quote run", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const first = await requestQuote(client, jobId);
    const second = await requestQuote(client, jobId);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data.accepted).toBe(true);
    expect(second.data.created).toBe(false);
    expect(second.data.deduplicated).toBe(true);
    expect(second.data.reasonCode).toBe("already_in_progress");
    expect(second.data.quoteRequestId).toBe(first.data.quoteRequestId);
    expect(second.data.quoteRunId).toBe(first.data.quoteRunId);
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(1);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(1);
  });

  it("rejects with already_received when the job already has a published quote run", async () => {
    const { data, error } = await requestQuote(client, PUBLISHED_JOB_ID);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("already_received");
  });

  it("rejects with retry_required when the latest request failed and force_retry is false", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    await insertFailedQuoteRequest(admin, jobId, clientUserId);

    const { data, error } = await requestQuote(client, jobId, false);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("retry_required");
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(1);
  });

  it("creates a fresh request when force_retry is true after a failed request", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    await insertFailedQuoteRequest(admin, jobId, clientUserId);

    const { data, error } = await requestQuote(client, jobId, true);

    expect(error).toBeNull();
    expect(data.accepted).toBe(true);
    expect(data.created).toBe(true);
    expect(data.status).toBe("queued");
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(2);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(1);
  });

  it.each([
    {
      name: "archived",
      prepare: () => buildQuoteReadyJob({ archived_at: new Date().toISOString() }),
      reasonCode: "archived",
    },
    {
      name: "missing_part",
      prepare: async () => ({ jobId: await insertTestJob(admin, clientUserId) }),
      reasonCode: "missing_part",
    },
    {
      name: "unsupported_service_kind",
      prepare: () =>
        buildQuoteReadyJob({
          requested_service_kinds: ["cad_modeling"],
          primary_service_kind: "cad_modeling",
        }),
      reasonCode: "unsupported_service_kind",
    },
    {
      name: "missing_cad",
      prepare: () => buildJobMissingCad(),
      reasonCode: "missing_cad",
    },
    {
      name: "missing_requirements",
      prepare: () => buildJobMissingRequirements(),
      reasonCode: "missing_requirements",
    },
    {
      name: "no_enabled_vendors",
      prepare: () => buildQuoteReadyJob({}, { applicable_vendors: [] }),
      reasonCode: "no_enabled_vendors",
      requestedVendors: [],
    },
  ])("rejects with $reasonCode when $name blocks quote collection", async ({ prepare, reasonCode, requestedVendors }) => {
    const { jobId } = await prepare();
    testJobId = jobId;

    const { data, error } = await requestQuote(client, jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe(reasonCode);

    if (requestedVendors) {
      expect(data.requestedVendors).toEqual(requestedVendors);
    }
  });

  it("rejects cross-org access with a permission exception", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const foreignUser = await createForeignOrgUser(admin);
    createdOrganizationIds.push(foreignUser.organizationId);
    createdUserIds.push(foreignUser.userId);

    const foreignClient = createAnonClient(supabaseUrl);
    await signInWithPassword(foreignClient, foreignUser.email, foreignUser.password);

    const { data, error } = await requestQuote(foreignClient, jobId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error.code).toBe("P0001");
    expect(error.message).toMatch(/do not have permission/i);
  });
});
