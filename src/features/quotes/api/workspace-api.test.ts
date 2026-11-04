import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClientQuoteWorkspaceByJobIds, fetchPartDetailByJobId } from "./workspace-api";

// OVD-1033 P2-11: count the Supabase requests the client workspace reads send. Every
// `from(table)` chain is recorded once when awaited and every rpc call once, so a test can
// pin how many round trips one read costs instead of only what it returns.
type RecordedRequest =
  | { kind: "from"; table: string; ops: Array<[string, ...unknown[]]> }
  | { kind: "rpc"; fn: string; args: unknown };

const recorder = vi.hoisted(() => {
  const requests: RecordedRequest[] = [];
  const state: { respond: (request: RecordedRequest) => { data: unknown; error: unknown } } = {
    respond: () => ({ data: [], error: null }),
  };

  function from(table: string) {
    const request: RecordedRequest = { kind: "from", table, ops: [] };
    let recorded = false;
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
              if (!recorded) {
                recorded = true;
                requests.push(request);
              }
              return Promise.resolve(state.respond(request)).then(resolve, reject);
            };
          }

          return (...args: unknown[]) => {
            request.ops.push([String(property), ...args]);
            return builder;
          };
        },
      },
    );

    return builder;
  }

  function rpc(fn: string, args: unknown) {
    const request: RecordedRequest = { kind: "rpc", fn, args };
    requests.push(request);
    return Promise.resolve(state.respond(request));
  }

  return { requests, state, from, rpc };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => recorder.from(table),
    rpc: (fn: string, args: unknown) => recorder.rpc(fn, args),
  },
}));

const ORGANIZATION_ID = "org-1";
const JOB_IDS = Array.from({ length: 10 }, (_, index) => `job-${index + 1}`);

function makeJob(id: string) {
  return {
    id,
    organization_id: ORGANIZATION_ID,
    project_id: null,
    // A selected offer without a published package is the case that used to send a second
    // api_list_client_quote_workspace call from the summary builder.
    selected_vendor_quote_offer_id: id === "job-1" ? "offer-1" : null,
    created_by: "user-1",
    title: `Part ${id}`,
    description: null,
    status: "uploaded",
    source: "client_home",
    active_pricing_policy_id: null,
    tags: [],
    requested_service_kinds: ["manufacturing_quote"],
    primary_service_kind: "manufacturing_quote",
    service_notes: null,
    requested_quote_quantities: [1],
    requested_by_date: null,
    archived_at: null,
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
  };
}

function makePart(jobId: string) {
  return {
    id: `part-${jobId}`,
    job_id: jobId,
    organization_id: ORGANIZATION_ID,
    name: `Part ${jobId}`,
    normalized_key: jobId,
    cad_file_id: null,
    drawing_file_id: null,
    quantity: 1,
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
  };
}

function makeMetadata(jobId: string) {
  // job-1 and job-2 are two revisions of the same part number.
  const revisions: Record<string, string> = { "job-1": "A", "job-2": "B" };

  return {
    partId: `part-${jobId}`,
    jobId,
    organizationId: ORGANIZATION_ID,
    description: `Bracket ${jobId}`,
    partNumber: jobId in revisions ? "1234-56789" : `PN-${jobId}`,
    revision: revisions[jobId] ?? null,
    material: "6061-T6",
    quantity: 1,
    quoteQuantities: [1],
  };
}

function idsFrom(request: Extract<RecordedRequest, { kind: "from" }>, column: string): string[] | null {
  const filter = request.ops.find((op) => op[0] === "in" && op[1] === column);
  return filter ? (filter[2] as string[]) : null;
}

function isOrganizationScoped(request: RecordedRequest) {
  return (
    request.kind === "from" &&
    request.ops.some((op) => op[0] === "eq" && op[1] === "organization_id")
  );
}

function respond(request: RecordedRequest) {
  if (request.kind === "rpc") {
    const jobIds = ((request.args as { p_job_ids?: string[] } | undefined)?.p_job_ids ?? []).filter((id) =>
      JOB_IDS.includes(id),
    );

    if (request.fn === "api_list_client_part_metadata") {
      return { data: jobIds.map(makeMetadata), error: null };
    }

    if (request.fn === "api_list_client_quote_workspace") {
      return {
        data: jobIds.map((jobId) => ({
          jobId,
          latestQuoteRun: null,
          selectedOffer:
            jobId === "job-1"
              ? { id: "offer-1", supplier: "Xometry", total_price_usd: 100, lead_time_business_days: 7 }
              : null,
          vendorQuotes: [],
        })),
        error: null,
      };
    }

    return { data: null, error: null };
  }

  if (request.ops.some((op) => op[0] === "maybeSingle" || op[0] === "single")) {
    return { data: null, error: null };
  }

  if (request.table === "jobs") {
    const ids = idsFrom(request, "id") ?? JOB_IDS;
    return { data: ids.filter((id) => JOB_IDS.includes(id)).map(makeJob), error: null };
  }

  if (request.table === "parts") {
    const ids = idsFrom(request, "job_id") ?? JOB_IDS;
    return { data: ids.filter((id) => JOB_IDS.includes(id)).map(makePart), error: null };
  }

  return { data: [], error: null };
}

function countRpc(fn: string) {
  return recorder.requests.filter((request) => request.kind === "rpc" && request.fn === fn).length;
}

function countTable(table: string) {
  return recorder.requests.filter((request) => request.kind === "from" && request.table === table).length;
}

describe("client workspace request fan-out (OVD-1033 P2-11)", () => {
  beforeEach(() => {
    recorder.requests.length = 0;
    recorder.state.respond = respond;
  });

  afterEach(() => {
    recorder.requests.length = 0;
  });

  it("calls the metadata RPC and the workspace RPC once each per workspace fetch", async () => {
    const items = await fetchClientQuoteWorkspaceByJobIds(["job-1"]);

    expect(items).toHaveLength(1);
    // The summary is built from the rows the workspace read already holds, so the selected
    // offer and the request metadata still come through without a second read.
    expect(items[0]?.summary).toMatchObject({
      jobId: "job-1",
      partNumber: "1234-56789",
      revision: "A",
      requestedServiceKinds: ["manufacturing_quote"],
      selectedSupplier: "Xometry",
      selectedPriceUsd: 100,
      selectedLeadTimeBusinessDays: 7,
    });
    expect(countRpc("api_list_client_part_metadata")).toBe(1);
    expect(countRpc("api_list_client_quote_workspace")).toBe(1);
  });

  it("reads parts, job files, jobs and published packages once each per workspace fetch", async () => {
    await fetchClientQuoteWorkspaceByJobIds(JOB_IDS);

    expect(countTable("parts")).toBe(1);
    expect(countTable("job_files")).toBe(1);
    expect(countTable("jobs")).toBe(1);
    expect(countTable("published_quote_packages")).toBe(1);
    // jobs, job_files, parts, project_jobs, quote_requests, service_request_line_items,
    // published_quote_packages, drawing_preview_assets, cad_preview_assets + 2 RPCs.
    expect(recorder.requests).toHaveLength(11);
  });

  it("builds part detail from the workspace rows without an organization-wide summary scan", async () => {
    const detail = await fetchPartDetailByJobId("job-1");

    expect(detail.revisionSiblings).toEqual([{ jobId: "job-2", revision: "B", title: "1234-56789 rev B" }]);
    expect(recorder.requests.filter(isOrganizationScoped)).toEqual([]);
    expect(countTable("project_jobs")).toBe(1);
    expect(countTable("drawing_preview_assets")).toBe(1);
    expect(countRpc("api_list_client_quote_workspace")).toBe(1);
  });

  it("skips the revision sibling lookup for a part without a part number", async () => {
    recorder.state.respond = (request) =>
      request.kind === "rpc" && request.fn === "api_list_client_part_metadata"
        ? { data: [], error: null }
        : respond(request);

    const detail = await fetchPartDetailByJobId("job-3");

    expect(detail.revisionSiblings).toEqual([]);
    expect(countRpc("api_list_client_part_metadata")).toBe(1);
    expect(recorder.requests).toHaveLength(11);
  });
});
