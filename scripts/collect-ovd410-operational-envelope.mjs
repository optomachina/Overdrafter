#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { isDirectCli } from "./xometry-stable-egress-contract.mjs";

export const OVD410_PRODUCTION_PROJECT_REF = "ozuatdcakezjtevztjlr";
export const OVD410_PRODUCTION_SUPABASE_URL = `https://${OVD410_PRODUCTION_PROJECT_REF}.supabase.co`;
export const OVD410_OPERATIONAL_ENVELOPE_PAGE_SIZE = 1_000;
export const OVD410_OPERATIONAL_ENVELOPE_TIMEOUT_MS = 10_000;
export const OVD410_OPERATIONAL_ENVELOPE_OVERALL_TIMEOUT_MS = 30_000;

export const OVD410_COMMERCIAL_CONTROLS = Object.freeze([
  "automatic_quote_collection",
  "commercial_admin_mutations",
  "order_administration",
  "promotion_codes",
]);

const TABLE_CONTRACTS = Object.freeze([
  Object.freeze({
    table: "work_queue",
    outputKey: "workQueue",
    statuses: Object.freeze([
      "cancelled",
      "completed",
      "failed",
      "queued",
      "running",
    ]),
    activeStatuses: new Set(["queued", "running"]),
  }),
  Object.freeze({
    table: "quote_requests",
    outputKey: "quoteRequests",
    statuses: Object.freeze([
      "canceled",
      "failed",
      "queued",
      "received",
      "requesting",
    ]),
    activeStatuses: new Set(["queued", "requesting"]),
  }),
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ROWS_PER_TABLE = 100_000;
const GENERIC_CLI_FAILURE =
  "OVD-410 operational envelope collection failed closed.\n";

class OperationalEnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperationalEnvelopeError";
  }
}

function fail(message) {
  throw new OperationalEnvelopeError(message);
}

function parseJwtPayload(secret) {
  const segments = secret.split(".");
  if (segments.length !== 3) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      fail("Invalid secret.");
    }
    return payload;
  } catch (error) {
    if (error instanceof OperationalEnvelopeError) throw error;
    fail("Invalid secret.");
  }
}

/**
 * Validates legacy service-role JWT project binding when present. Modern
 * `sb_secret_` keys are opaque, so their target is bounded by the fixed URL and
 * verified by the hosted gateway.
 */
export function validateServiceRoleSecret(secret) {
  if (typeof secret !== "string" || secret === "" || secret.trim() !== secret) {
    fail("Invalid secret.");
  }

  const payload = parseJwtPayload(secret);
  if (payload) {
    if (
      payload.ref !== OVD410_PRODUCTION_PROJECT_REF ||
      payload.role !== "service_role"
    ) {
      fail("Invalid secret binding.");
    }
    return;
  }

  if (!/^sb_secret_[A-Za-z0-9_-]+$/.test(secret)) fail("Invalid secret.");
}

function projectOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    fail("Invalid client binding.");
  }
}

function validateClientBinding(client) {
  if (!client || typeof client !== "object") fail("Invalid client.");

  const discoverableUrls = [client.supabaseUrl, client.rest?.url].filter(
    (value) => typeof value === "string",
  );
  if (discoverableUrls.length === 0) {
    fail("Client binding is not authoritative.");
  }
  for (const value of discoverableUrls) {
    if (projectOrigin(value) !== OVD410_PRODUCTION_SUPABASE_URL) {
      fail("Invalid client binding.");
    }
  }
}

function createBoundClient(serviceRoleSecret, createClientImpl) {
  validateServiceRoleSecret(serviceRoleSecret);
  return createClientImpl(OVD410_PRODUCTION_SUPABASE_URL, serviceRoleSecret, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function executeRequest(
  query,
  { requestTimeoutMs, deadlineAt, overallSignal },
) {
  if (!query || typeof query.abortSignal !== "function") {
    fail("Invalid request dependency.");
  }

  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0 || overallSignal.aborted) {
    fail("Operational envelope request failed.");
  }

  const controller = new AbortController();
  const abortForOverallDeadline = () => controller.abort();
  overallSignal.addEventListener("abort", abortForOverallDeadline, {
    once: true,
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(
          new OperationalEnvelopeError("Operational envelope request failed."),
        );
      },
      Math.min(requestTimeoutMs, remainingMs),
    );
  });

  try {
    return await Promise.race([query.abortSignal(controller.signal), timeout]);
  } catch (error) {
    if (error instanceof OperationalEnvelopeError) throw error;
    fail("Operational envelope request failed.");
  } finally {
    clearTimeout(timer);
    overallSignal.removeEventListener("abort", abortForOverallDeadline);
  }
}

function validateControls(response) {
  if (response?.error || !response?.data || Array.isArray(response.data)) {
    fail("Invalid rollout-control response.");
  }

  const sourceControls = response.data.controls;
  if (
    !Array.isArray(sourceControls) ||
    sourceControls.length !== OVD410_COMMERCIAL_CONTROLS.length
  ) {
    fail("Invalid rollout-control response.");
  }

  const controls = sourceControls.map((control) => {
    if (
      !control ||
      typeof control !== "object" ||
      Array.isArray(control) ||
      typeof control.capability !== "string" ||
      typeof control.enabled !== "boolean"
    ) {
      fail("Invalid rollout-control response.");
    }
    return { capability: control.capability, enabled: control.enabled };
  });
  controls.sort((left, right) =>
    left.capability.localeCompare(right.capability),
  );

  if (
    controls.some(
      (control, index) =>
        control.capability !== OVD410_COMMERCIAL_CONTROLS[index] ||
        control.enabled,
    )
  ) {
    fail("Commercial rollout controls are not safely disabled.");
  }

  return controls;
}

function validatePage(
  response,
  contract,
  expectedCount,
  expectedLength,
  previousId,
) {
  if (
    response?.error ||
    !Number.isSafeInteger(response?.count) ||
    response.count < 0 ||
    !Array.isArray(response.data)
  ) {
    fail("Invalid table response.");
  }
  if (
    response.count !== expectedCount ||
    response.data.length !== expectedLength
  ) {
    fail("Table changed or pagination was incomplete.");
  }

  const statusSet = new Set(contract.statuses);
  let lastId = previousId;
  const rows = response.data.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.id !== "string" ||
      !UUID_PATTERN.test(row.id) ||
      typeof row.status !== "string" ||
      !statusSet.has(row.status) ||
      (lastId !== null && row.id <= lastId)
    ) {
      fail("Invalid table row.");
    }
    lastId = row.id;
    return { id: row.id, status: row.status };
  });

  return rows;
}

async function collectTable(client, contract, pageSize, requestBudget) {
  const rows = [];
  let expectedCount = null;
  let previousId = null;

  while (expectedCount === null || rows.length < expectedCount) {
    let query = client
      .schema("public")
      .from(contract.table)
      .select("id,status", { count: "exact" })
      .order("id", { ascending: true })
      .limit(pageSize);
    if (previousId !== null) query = query.gt("id", previousId);

    const response = await executeRequest(query, requestBudget);

    if (expectedCount === null) {
      if (
        !Number.isSafeInteger(response?.count) ||
        response.count > MAX_ROWS_PER_TABLE
      ) {
        fail("Invalid table count.");
      }
      expectedCount = response.count;
    }

    const remainingCount = expectedCount - rows.length;
    const expectedLength = Math.min(pageSize, remainingCount);
    const pageRows = validatePage(
      response,
      contract,
      remainingCount,
      expectedLength,
      previousId,
    );
    rows.push(...pageRows);
    previousId = rows.at(-1)?.id ?? previousId;
  }

  const statusCounts = Object.fromEntries(
    contract.statuses.map((status) => [status, 0]),
  );
  let activeCount = 0;
  for (const row of rows) {
    statusCounts[row.status] += 1;
    if (contract.activeStatuses.has(row.status)) activeCount += 1;
  }
  if (activeCount !== 0) fail("Active operational rows remain.");

  return {
    totalCount: rows.length,
    activeCount,
    statusCounts,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(rows.map((row) => [row.id, row.status])))
      .digest("hex"),
  };
}

async function collectControls(client, requestBudget) {
  const response = await executeRequest(
    client.schema("public").rpc("api_get_commercial_rollout_controls"),
    requestBudget,
  );
  return validateControls(response);
}

async function collectSingleScan(client, pageSize, requestBudget) {
  const controlsBefore = await collectControls(client, requestBudget);
  const result = { controls: controlsBefore };

  for (const contract of TABLE_CONTRACTS) {
    result[contract.outputKey] = await collectTable(
      client,
      contract,
      pageSize,
      requestBudget,
    );
  }

  const controlsAfter = await collectControls(client, requestBudget);
  if (JSON.stringify(controlsBefore) !== JSON.stringify(controlsAfter)) {
    fail("Operational envelope changed during collection.");
  }

  return result;
}

async function verifyFinalActiveCounts(client, requestBudget) {
  for (const contract of TABLE_CONTRACTS) {
    const response = await executeRequest(
      client
        .schema("public")
        .from(contract.table)
        .select("status", { count: "exact", head: true })
        .in("status", [...contract.activeStatuses]),
      requestBudget,
    );
    if (response?.error || response?.data !== null || response?.count !== 0) {
      fail("Active operational rows remain.");
    }
  }
}

/**
 * Collects a sanitized, deterministic production containment envelope. The
 * result contains no raw rows: table evidence is reduced to counts and a
 * SHA-256 fingerprint of ordered `[id,status]` pairs.
 */
export async function collectOperationalEnvelope({
  serviceRoleSecret,
  client,
  createClientImpl = createClient,
  pageSize = OVD410_OPERATIONAL_ENVELOPE_PAGE_SIZE,
  requestTimeoutMs = OVD410_OPERATIONAL_ENVELOPE_TIMEOUT_MS,
  overallTimeoutMs = OVD410_OPERATIONAL_ENVELOPE_OVERALL_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    fail("Invalid page size.");
  }
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 60_000
  ) {
    fail("Invalid request timeout.");
  }
  if (
    !Number.isSafeInteger(overallTimeoutMs) ||
    overallTimeoutMs < 1 ||
    overallTimeoutMs > 120_000
  ) {
    fail("Invalid overall timeout.");
  }

  const boundClient =
    client ?? createBoundClient(serviceRoleSecret, createClientImpl);
  validateClientBinding(boundClient);

  const startedAt = Date.now();
  const deadlineAt = startedAt + overallTimeoutMs;
  const overallController = new AbortController();
  const overallTimer = setTimeout(
    () => overallController.abort(),
    overallTimeoutMs,
  );
  const requestBudget = {
    requestTimeoutMs,
    deadlineAt,
    overallSignal: overallController.signal,
  };

  try {
    const firstScan = await collectSingleScan(
      boundClient,
      pageSize,
      requestBudget,
    );
    const secondScan = await collectSingleScan(
      boundClient,
      pageSize,
      requestBudget,
    );
    if (JSON.stringify(firstScan) !== JSON.stringify(secondScan)) {
      fail("Operational envelope did not remain stable.");
    }
    await verifyFinalActiveCounts(boundClient, requestBudget);
    const finalControls = await collectControls(boundClient, requestBudget);
    if (JSON.stringify(firstScan.controls) !== JSON.stringify(finalControls)) {
      fail("Operational envelope changed during collection.");
    }
    if (Date.now() >= deadlineAt || overallController.signal.aborted) {
      fail("Operational envelope request failed.");
    }
    return firstScan;
  } finally {
    clearTimeout(overallTimer);
  }
}

/** Writes exactly one compact envelope line or one generic failure line. */
export async function runOperationalEnvelopeCli({
  args = process.argv.slice(2),
  env = process.env,
  output = process.stdout,
  errorOutput = process.stderr,
  collect = collectOperationalEnvelope,
} = {}) {
  try {
    if (!Array.isArray(args) || args.length !== 0)
      fail("Unexpected arguments.");
    const envelope = await collect({
      serviceRoleSecret: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    output.write(`${JSON.stringify(envelope)}\n`);
    return 0;
  } catch {
    errorOutput.write(GENERIC_CLI_FAILURE);
    return 1;
  }
}

if (isDirectCli(import.meta.url)) {
  process.exitCode = await runOperationalEnvelopeCli();
}
