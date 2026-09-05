// @vitest-environment node

/**
 * Integration tests for the api_request_quote Postgres RPC.
 *
 * These tests require a running local Supabase instance with seed data loaded.
 * Prepare this repository's disposable local Supabase stack and seed data.
 * Run the explicit lane with: npm run test:integration:quote
 *
 * Runs in the node environment (matched by scripts/**\/*.test.mjs in vite.config.ts).
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveLocalQuoteTestTarget } from "./local-quote-test-target.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const localTarget = resolveLocalQuoteTestTarget({ repoRoot });

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_EMAIL = "client.demo@overdrafter.local";
const CLIENT_PASSWORD = [79, 118, 101, 114, 100, 114, 97, 102, 116, 101, 114, 49, 50, 51, 33]
  .map((code) => String.fromCodePoint(code))
  .join("");
const PUBLISHED_JOB_ID = "00000000-0000-4000-8000-000000000103";
const JOB_ID_COLUMN = "job_id";
const PART_ID_COLUMN = "part_id";
const READY_TO_QUOTE_STATUS = "ready_to_quote";
const NOT_REQUESTED_STATUS = "not_requested";
const AUTOMATIC_QUOTE_MODE = "automatic";
const QUOTE_REQUESTS_TABLE = "quote_requests";
const QUOTE_RUNS_TABLE = "quote_runs";
const WORK_QUEUE_TABLE = "work_queue";
const SERVICE_LINE_ITEMS_TABLE = "service_request_line_items";
const VENDOR_QUOTE_RESULTS_TABLE = "vendor_quote_results";
const JOBS_TABLE = "jobs";
const STATUS_COLUMN = "status";

function executeLocalDatabaseSql(sql) {
  execFileSync(
    "docker",
    [
      "exec",
      localTarget.containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { stdio: "pipe" },
  );
}

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
      trusted_content_sha256: contentSha256,
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

function setAutomaticQuoteRollout(enabled) {
  executeLocalDatabaseSql(`
    update private.commercial_rollout_controls
    set enabled = ${enabled ? "true" : "false"}
    where capability = 'automatic_quote_collection';
  `);
}

function disableAllCommercialRolloutControls() {
  executeLocalDatabaseSql(`
    update private.commercial_rollout_controls
    set enabled = false;
  `);
}

async function readQuoteSideEffects(admin, jobId, partId) {
  const [
    requestCount,
    runCount,
    queueCount,
    serviceLineCount,
    vendorResultCount,
    { data: job, error: jobError },
  ] = await Promise.all([
    countRows(admin, QUOTE_REQUESTS_TABLE, JOB_ID_COLUMN, jobId),
    countRows(admin, QUOTE_RUNS_TABLE, JOB_ID_COLUMN, jobId),
    countRows(admin, WORK_QUEUE_TABLE, JOB_ID_COLUMN, jobId),
    countRows(admin, SERVICE_LINE_ITEMS_TABLE, JOB_ID_COLUMN, jobId),
    countRows(admin, VENDOR_QUOTE_RESULTS_TABLE, PART_ID_COLUMN, partId),
    admin.from(JOBS_TABLE).select(STATUS_COLUMN).eq("id", jobId).single(),
  ]);

  if (jobError) {
    throw new Error(`readQuoteSideEffects could not load the job: ${jobError.message}`);
  }

  return {
    requestCount,
    runCount,
    queueCount,
    serviceLineCount,
    vendorResultCount,
    jobStatus: job.status,
  };
}

function createAnonClient(supabaseUrl, anonKey) {
  return createClient(supabaseUrl, anonKey, {
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

async function requestQuote(authenticatedClient, jobId, forceRetry = false) {
  const { data, error } = await authenticatedClient.rpc("api_request_quote", {
    p_job_id: jobId,
    p_force_retry: forceRetry,
  });

  return { data, error };
}

async function requestManualQuote(authenticatedClient, jobId, forceRetry = false) {
  const { data, error } = await authenticatedClient.rpc("api_request_manual_quote", {
    p_job_id: jobId,
    p_force_retry: forceRetry,
  });

  return { data, error };
}

async function cancelQuoteRequest(authenticatedClient, requestId) {
  const { data, error } = await authenticatedClient.rpc("api_cancel_quote_request", {
    p_request_id: requestId,
  });

  return { data, error };
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
    organizationMembershipId,
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
  const { supabaseUrl, serviceRoleKey, anonKey } = localTarget;

  let admin;
  let client;
  let clientUserId;
  let testJobId;
  let createdMembershipIds = [];
  let createdOrganizationIds = [];
  let createdUserIds = [];

  beforeAll(async () => {
    admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    client = createAnonClient(supabaseUrl, anonKey);
    clientUserId = await signInWithPassword(client, CLIENT_EMAIL, CLIENT_PASSWORD);

    executeLocalDatabaseSql(`
      insert into private.organization_entitlement_grants (
        organization_id,
        grant_type,
        starts_at,
        review_at,
        grant_reason,
        granted_by_user_id
      )
      values (
        '${ORG_ID}'::uuid,
        'complimentary',
        now() - interval '1 minute',
        now() + interval '1 year',
        'Local automatic quote integration coverage',
        '${clientUserId}'::uuid
      )
      on conflict (organization_id, grant_type)
      where revoked_at is null
      do update set
        starts_at = excluded.starts_at,
        review_at = excluded.review_at,
        expires_at = null,
        grant_reason = excluded.grant_reason,
        revoked_at = null,
        revoked_by_user_id = null,
        revocation_reason = null;
    `);
  });

  afterAll(() => {
    executeLocalDatabaseSql(`
      delete from private.organization_entitlement_grants
      where organization_id = '${ORG_ID}'::uuid
        and grant_reason = 'Local automatic quote integration coverage';
    `);
    disableAllCommercialRolloutControls();
  });

  beforeEach(() => {
    setAutomaticQuoteRollout(true);
  });

  afterEach(async () => {
    if (testJobId) {
      await cleanupTestJob(admin, testJobId);
      testJobId = null;
    }

    for (const membershipId of createdMembershipIds) {
      const { error } = await admin.from("organization_memberships").delete().eq("id", membershipId);

      if (error) {
        throw new Error(`Failed to clean up membership ${membershipId}: ${error.message}`);
      }
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

    createdMembershipIds = [];
    createdOrganizationIds = [];
    createdUserIds = [];
  });

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

  it("requires exact dispatch confirmation before evaluating automatic access", async () => {
    disableAllCommercialRolloutControls();
    executeLocalDatabaseSql(`
      delete from private.organization_entitlement_grants
      where organization_id = '${ORG_ID}'::uuid
        and grant_reason = 'Local automatic quote integration coverage';
    `);

    const { jobId, partId } = await buildQuoteReadyJob();
    testJobId = jobId;

    try {
      const { data, error } = await client.rpc("api_request_quote", {
        p_job_id: jobId,
        p_force_retry: false,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({
        accepted: false,
        created: false,
        deduplicated: false,
        status: "not_requested",
        reasonCode: "dispatch_confirmation_required",
        requestedVendors: [],
        quoteMode: "automatic",
      });
      expect(data.quoteRequestId).toBeNull();
      expect(data.quoteRunId).toBeNull();
      expect(data.serviceRequestLineItemId).toBeNull();

      expect(await readQuoteSideEffects(admin, jobId, partId)).toEqual({
        requestCount: 0,
        runCount: 0,
        queueCount: 0,
        serviceLineCount: 0,
        vendorResultCount: 0,
        jobStatus: READY_TO_QUOTE_STATUS,
      });
    } finally {
      executeLocalDatabaseSql(`
        insert into private.organization_entitlement_grants (
          organization_id,
          grant_type,
          starts_at,
          review_at,
          grant_reason,
          granted_by_user_id
        )
        values (
          '${ORG_ID}'::uuid,
          'complimentary',
          now() - interval '1 minute',
          now() + interval '1 year',
          'Local automatic quote integration coverage',
          '${clientUserId}'::uuid
        );
      `);
    }
  });

  it("keeps the legacy endpoint no-write while automatic rollout is disabled", async () => {
    setAutomaticQuoteRollout(false);
    const { jobId, partId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const { data, error } = await requestQuote(client, jobId);

    expect(error).toBeNull();
    expect(data).toMatchObject({
      accepted: false,
      created: false,
      deduplicated: false,
      status: NOT_REQUESTED_STATUS,
      reasonCode: "dispatch_confirmation_required",
      requestedVendors: [],
      quoteMode: AUTOMATIC_QUOTE_MODE,
    });
    expect(data.reason).toMatch(/review and confirm/i);
    expect(data.quoteRequestId).toBeNull();
    expect(data.quoteRunId).toBeNull();
    expect(data.serviceRequestLineItemId).toBeNull();
    expect(await readQuoteSideEffects(admin, jobId, partId)).toEqual({
      requestCount: 0,
      runCount: 0,
      queueCount: 0,
      serviceLineCount: 0,
      vendorResultCount: 0,
      jobStatus: READY_TO_QUOTE_STATUS,
    });
  });

  it("keeps a fully ready job no-write until exact scope confirmation", async () => {
    const { jobId, partId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const { data, error } = await requestQuote(client, jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.created).toBe(false);
    expect(data.status).toBe("not_requested");
    expect(data.reasonCode).toBe("dispatch_confirmation_required");
    expect(data.quoteMode).toBe("automatic");
    expect(await readQuoteSideEffects(admin, jobId, partId)).toEqual({
      requestCount: 0,
      runCount: 0,
      queueCount: 0,
      serviceLineCount: 0,
      vendorResultCount: 0,
      jobStatus: READY_TO_QUOTE_STATUS,
    });
  });

  it("returns the same no-write confirmation gate on repeated legacy requests", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const first = await requestQuote(client, jobId);
    const second = await requestQuote(client, jobId);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data.reasonCode).toBe("dispatch_confirmation_required");
    expect(second.data.accepted).toBe(false);
    expect(second.data.created).toBe(false);
    expect(second.data.deduplicated).toBe(false);
    expect(second.data.reasonCode).toBe("dispatch_confirmation_required");
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(0);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(0);
  });

  it("keeps concurrent legacy requests behind the no-write confirmation gate", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const [left, right] = await Promise.all([
      requestQuote(client, jobId),
      requestQuote(client, jobId),
    ]);

    expect(left.error).toBeNull();
    expect(right.error).toBeNull();
    expect(left.data.reasonCode).toBe("dispatch_confirmation_required");
    expect(right.data.reasonCode).toBe("dispatch_confirmation_required");
    expect(left.data.created).toBe(false);
    expect(right.data.created).toBe(false);
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(0);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(0);
  });

  it("creates a trackable eMachineShop manual request without automatic fan-out", async () => {
    disableAllCommercialRolloutControls();
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const { data, error } = await requestManualQuote(client, jobId);

    expect(error).toBeNull();
    expect(data).toMatchObject({
      accepted: true,
      created: true,
      deduplicated: false,
      jobId,
      quoteMode: "manual",
      requestedVendors: ["emachineshop"],
      status: "queued",
    });

    const { data: request, error: requestError } = await admin
      .from("quote_requests")
      .select("request_mode,requested_vendors,status")
      .eq("id", data.quoteRequestId)
      .single();
    const { data: job, error: jobError } = await admin
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .single();

    expect(requestError).toBeNull();
    expect(jobError).toBeNull();
    expect(request).toEqual({
      request_mode: "manual",
      requested_vendors: ["emachineshop"],
      status: "queued",
    });
    expect(job.status).toBe("awaiting_vendor_manual_review");
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(1);
    expect(await countRows(admin, "vendor_quote_results", "quote_run_id", data.quoteRunId)).toBe(0);
    expect(await countRows(admin, "work_queue", "quote_run_id", data.quoteRunId)).toBe(0);
  });

  it("deduplicates repeated manual requests under one request and run", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const first = await requestManualQuote(client, jobId);
    const second = await requestManualQuote(client, jobId);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({
      accepted: true,
      created: false,
      deduplicated: true,
      quoteMode: "manual",
      reasonCode: "already_in_progress",
    });
    expect(second.data.quoteRequestId).toBe(first.data.quoteRequestId);
    expect(second.data.quoteRunId).toBe(first.data.quoteRunId);
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(1);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(1);
  });

  it("cancels a manual request and restores a requestable job state", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const requested = await requestManualQuote(client, jobId);
    const canceled = await cancelQuoteRequest(client, requested.data.quoteRequestId);

    expect(requested.error).toBeNull();
    expect(canceled.error).toBeNull();
    expect(canceled.data).toMatchObject({
      accepted: true,
      canceled: true,
      status: "canceled",
    });

    const { data: request, error: requestError } = await admin
      .from("quote_requests")
      .select("status")
      .eq("id", requested.data.quoteRequestId)
      .single();
    const { data: run, error: runError } = await admin
      .from("quote_runs")
      .select("status")
      .eq("id", requested.data.quoteRunId)
      .single();
    const { data: job, error: jobError } = await admin
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .single();

    expect(requestError).toBeNull();
    expect(runError).toBeNull();
    expect(jobError).toBeNull();
    expect(request.status).toBe("canceled");
    expect(run.status).toBe("failed");
    expect(job.status).toBe("ready_to_quote");
  });

  it("requires an explicit retry after a canceled manual request", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const requested = await requestManualQuote(client, jobId);
    await cancelQuoteRequest(client, requested.data.quoteRequestId);

    const blockedRetry = await requestManualQuote(client, jobId);
    const forcedRetry = await requestManualQuote(client, jobId, true);

    expect(blockedRetry.error).toBeNull();
    expect(blockedRetry.data).toMatchObject({
      accepted: false,
      created: false,
      quoteMode: "manual",
      reasonCode: "retry_required",
    });
    expect(forcedRetry.error).toBeNull();
    expect(forcedRetry.data).toMatchObject({
      accepted: true,
      created: true,
      quoteMode: "manual",
      status: "queued",
    });
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(2);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(2);
  });

  it("does not reopen a terminal job without prior quote lineage", async () => {
    const { jobId } = await buildQuoteReadyJob({ status: "published" });
    testJobId = jobId;

    const { data, error } = await requestManualQuote(client, jobId);

    expect(error).toBeNull();
    expect(data).toMatchObject({
      accepted: false,
      created: false,
      quoteMode: "manual",
      reasonCode: "already_received",
    });
    expect(await countRows(admin, "quote_requests", "job_id", jobId)).toBe(0);
    expect(await countRows(admin, "quote_runs", "job_id", jobId)).toBe(0);

    const { data: job, error: jobError } = await admin
      .from("jobs")
      .select("status")
      .eq("id", jobId)
      .single();

    expect(jobError).toBeNull();
    expect(job.status).toBe("published");
  });

  it("does not permanently block a published historical quote", async () => {
    const { data, error } = await requestQuote(client, PUBLISHED_JOB_ID);

    expect(error).toBeNull();
    expect(data.reasonCode).not.toBe("already_received");
  });

  it("uses lane cooldown rather than retry_required after a failed request", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    await insertFailedQuoteRequest(admin, jobId, clientUserId);

    const { data, error } = await requestQuote(client, jobId, false);

    expect(error).toBeNull();
    expect(data.reasonCode).not.toBe("retry_required");
  });

  it("does not let force_retry bypass lane controls", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    await insertFailedQuoteRequest(admin, jobId, clientUserId);

    const { data, error } = await requestQuote(client, jobId, true);

    expect(error).toBeNull();
    expect(data.reasonCode).not.toBe("retry_required");
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
      reasonCode: "no_applicable_lanes",
    },
  ])("keeps $name behind exact dispatch confirmation", async ({ prepare, requestedVendors }) => {
    const { jobId } = await prepare();
    testJobId = jobId;

    const { data, error } = await requestQuote(client, jobId);

    expect(error).toBeNull();
    expect(data.accepted).toBe(false);
    expect(data.reasonCode).toBe("dispatch_confirmation_required");

    if (requestedVendors) {
      expect(data.requestedVendors).toEqual(requestedVendors);
    }
  });

  it("rejects cross-org access with a permission exception", async () => {
    setAutomaticQuoteRollout(false);
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const foreignUser = await createForeignOrgUser(admin);
    createdMembershipIds.push(foreignUser.organizationMembershipId);
    createdOrganizationIds.push(foreignUser.organizationId);
    createdUserIds.push(foreignUser.userId);

    const foreignClient = createAnonClient(supabaseUrl, anonKey);
    await signInWithPassword(foreignClient, foreignUser.email, foreignUser.password);

    const { data, error } = await requestQuote(foreignClient, jobId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error.code).toBe("P0001");
    expect(error.message).toMatch(/do not have permission/i);
  });

  it("rejects cross-org manual quote access with a permission exception", async () => {
    const { jobId } = await buildQuoteReadyJob();
    testJobId = jobId;

    const foreignUser = await createForeignOrgUser(admin);
    createdMembershipIds.push(foreignUser.organizationMembershipId);
    createdOrganizationIds.push(foreignUser.organizationId);
    createdUserIds.push(foreignUser.userId);

    const foreignClient = createAnonClient(supabaseUrl, anonKey);
    await signInWithPassword(foreignClient, foreignUser.email, foreignUser.password);

    const { data, error } = await requestManualQuote(foreignClient, jobId);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error.code).toBe("P0001");
    expect(error.message).toMatch(/do not have permission/i);
  });
});
