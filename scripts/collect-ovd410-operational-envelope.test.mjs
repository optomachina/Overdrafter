import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  OVD410_COMMERCIAL_CONTROLS,
  OVD410_PRODUCTION_PROJECT_REF,
  OVD410_PRODUCTION_SUPABASE_URL,
  collectOperationalEnvelope,
  runOperationalEnvelopeCli,
  validateServiceRoleSecret,
} from "./collect-ovd410-operational-envelope.mjs";

const IDS = Object.freeze([
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
]);

function serviceRoleJwt({
  ref = OVD410_PRODUCTION_PROJECT_REF,
  role = "service_role",
} = {}) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ref, role })}.signature`;
}

function disabledControls() {
  return [...OVD410_COMMERCIAL_CONTROLS].reverse().map((capability) => ({
    capability,
    enabled: false,
    changeReason: "must never be retained",
    updatedByUserId: "customer-user-id",
  }));
}

function request(producer) {
  return {
    abortSignal(signal) {
      return Promise.resolve().then(() => producer(signal));
    },
  };
}

function fakeClient({
  controls = {
    data: { controls: disabledControls(), recentEvents: [] },
    error: null,
  },
  workQueue = [],
  quoteRequests = [],
  tableResponse,
  sentinelResponse,
  projectUrl = OVD410_PRODUCTION_SUPABASE_URL,
} = {}) {
  const calls = [];
  const rowsByTable = {
    work_queue: workQueue,
    quote_requests: quoteRequests,
  };
  const tableCallCounts = { work_queue: 0, quote_requests: 0 };
  const sentinelCallCounts = { work_queue: 0, quote_requests: 0 };
  let controlCallCount = 0;

  const client = {
    supabaseUrl: projectUrl,
    rest: { url: `${projectUrl}/rest/v1` },
    schema(schemaName) {
      calls.push({ operation: "schema", schemaName });
      return {
        rpc(name) {
          calls.push({ operation: "rpc", name });
          return request((signal) => {
            const callIndex = controlCallCount;
            controlCallCount += 1;
            if (typeof controls === "function") {
              return controls({ signal, callIndex });
            }
            return controls;
          });
        },
        from(table) {
          calls.push({ operation: "from", table });
          return {
            select(columns, options) {
              calls.push({ operation: "select", table, columns, options });
              if (options?.head === true) {
                return {
                  in(column, values) {
                    calls.push({ operation: "in", table, column, values });
                    return request((signal) => {
                      const callIndex = sentinelCallCounts[table];
                      sentinelCallCounts[table] += 1;
                      if (sentinelResponse) {
                        const custom = sentinelResponse({
                          table,
                          column,
                          values,
                          callIndex,
                          signal,
                          rows: rowsByTable[table],
                        });
                        if (custom !== undefined) return custom;
                      }
                      return {
                        data: null,
                        count: rowsByTable[table].filter((row) =>
                          values.includes(row.status),
                        ).length,
                        error: null,
                      };
                    });
                  },
                };
              }
              let afterId = null;
              let pageLimit = null;
              const builder = {
                order(column, options) {
                  calls.push({ operation: "order", table, column, options });
                  return builder;
                },
                limit(value) {
                  pageLimit = value;
                  calls.push({ operation: "limit", table, value });
                  return builder;
                },
                gt(column, value) {
                  afterId = value;
                  calls.push({ operation: "gt", table, column, value });
                  return builder;
                },
                abortSignal(signal) {
                  const callIndex = tableCallCounts[table];
                  tableCallCounts[table] += 1;
                  return Promise.resolve().then(() => {
                    if (tableResponse) {
                      const custom = tableResponse({
                        table,
                        afterId,
                        pageLimit,
                        callIndex,
                        signal,
                        rows: rowsByTable[table],
                      });
                      if (custom !== undefined) return custom;
                    }
                    const remainingRows = rowsByTable[table].filter(
                      (row) => afterId === null || row.id > afterId,
                    );
                    return {
                      data: remainingRows.slice(0, pageLimit),
                      count: remainingRows.length,
                      error: null,
                    };
                  });
                },
              };
              return builder;
            },
          };
        },
      };
    },
  };

  return { client, calls };
}

function fingerprint(rows) {
  return createHash("sha256")
    .update(JSON.stringify(rows.map(({ id, status }) => [id, status])))
    .digest("hex");
}

describe("OVD-410 operational envelope collector", () => {
  it("fully paginates ordered ID/status rows into deterministic sanitized evidence", async () => {
    const workQueue = [
      { id: IDS[0], status: "completed", payload: "provider-secret" },
      { id: IDS[1], status: "failed", organization_id: "customer-org" },
      { id: IDS[2], status: "cancelled", job_id: "customer-job" },
    ];
    const quoteRequests = [
      { id: IDS[0], status: "received", requested_by: "customer-user" },
      { id: IDS[3], status: "failed", failure_reason: "raw-provider-error" },
    ];
    const { client, calls } = fakeClient({ workQueue, quoteRequests });

    const envelope = await collectOperationalEnvelope({ client, pageSize: 2 });

    expect(envelope).toEqual({
      controls: OVD410_COMMERCIAL_CONTROLS.map((capability) => ({
        capability,
        enabled: false,
      })),
      workQueue: {
        totalCount: 3,
        activeCount: 0,
        statusCounts: {
          cancelled: 1,
          completed: 1,
          failed: 1,
          queued: 0,
          running: 0,
        },
        fingerprint: fingerprint(workQueue),
      },
      quoteRequests: {
        totalCount: 2,
        activeCount: 0,
        statusCounts: {
          canceled: 0,
          failed: 1,
          queued: 0,
          received: 1,
          requesting: 0,
        },
        fingerprint: fingerprint(quoteRequests),
      },
    });

    expect(calls.filter((call) => call.operation === "schema")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ schemaName: "public" }),
      ]),
    );
    const selects = calls.filter((call) => call.operation === "select");
    expect(selects).toHaveLength(8);
    expect(selects.filter((call) => call.columns === "id,status")).toEqual(
      expect.arrayContaining([
        {
          operation: "select",
          table: "work_queue",
          columns: "id,status",
          options: { count: "exact" },
        },
        {
          operation: "select",
          table: "quote_requests",
          columns: "id,status",
          options: { count: "exact" },
        },
      ]),
    );
    expect(selects.filter((call) => call.columns === "id,status")).toHaveLength(
      6,
    );
    expect(selects.filter((call) => call.columns === "status")).toEqual([
      {
        operation: "select",
        table: "work_queue",
        columns: "status",
        options: { count: "exact", head: true },
      },
      {
        operation: "select",
        table: "quote_requests",
        columns: "status",
        options: { count: "exact", head: true },
      },
    ]);
    expect(calls.filter((call) => call.operation === "limit")).toHaveLength(6);
    expect(calls.filter((call) => call.operation === "gt")).toEqual([
      { operation: "gt", table: "work_queue", column: "id", value: IDS[1] },
      { operation: "gt", table: "work_queue", column: "id", value: IDS[1] },
    ]);
    expect(calls.some((call) => call.operation === "range")).toBe(false);
    expect(calls.filter((call) => call.operation === "in")).toEqual([
      {
        operation: "in",
        table: "work_queue",
        column: "status",
        values: ["queued", "running"],
      },
      {
        operation: "in",
        table: "quote_requests",
        column: "status",
        values: ["queued", "requesting"],
      },
    ]);
    expect(calls.filter((call) => call.operation === "rpc")).toHaveLength(5);

    const serialized = JSON.stringify(envelope);
    for (const forbidden of [
      ...IDS,
      "provider-secret",
      "customer-org",
      "customer-job",
      "customer-user",
      "raw-provider-error",
      "changeReason",
      "recentEvents",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("pins production and accepts supported service-secret formats", async () => {
    const secret = serviceRoleJwt();
    const { client } = fakeClient();
    const createClientImpl = vi.fn(() => client);

    await collectOperationalEnvelope({
      serviceRoleSecret: secret,
      createClientImpl,
    });

    expect(createClientImpl).toHaveBeenCalledWith(
      OVD410_PRODUCTION_SUPABASE_URL,
      secret,
      {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false,
        },
      },
    );
    expect(() =>
      validateServiceRoleSecret("sb_secret_opaque-production-key"),
    ).not.toThrow();
  });

  it("validates the fixed constructor URL with a real client without network access", async () => {
    const secret = "sb_secret_real-client-binding-test";
    const fake = fakeClient();
    const forbiddenFetch = vi.fn(() => {
      throw new Error("Network access is forbidden in this regression.");
    });
    let realClient;
    const createClientImpl = vi.fn((url, serviceRoleSecret, options) => {
      realClient = createClient(url, serviceRoleSecret, {
        ...options,
        global: { fetch: forbiddenFetch },
      });
      realClient.schema = fake.client.schema.bind(fake.client);
      return realClient;
    });

    await collectOperationalEnvelope({
      serviceRoleSecret: secret,
      createClientImpl,
    });

    expect(realClient.supabaseUrl).toBe(OVD410_PRODUCTION_SUPABASE_URL);
    expect(realClient.rest.url).toBe(
      `${OVD410_PRODUCTION_SUPABASE_URL}/rest/v1`,
    );
    expect(createClientImpl).toHaveBeenCalledWith(
      OVD410_PRODUCTION_SUPABASE_URL,
      secret,
      expect.any(Object),
    );
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["work_queue", "queued"],
    ["work_queue", "running"],
    ["quote_requests", "queued"],
    ["quote_requests", "requesting"],
  ])("rejects active %s status %s", async (table, status) => {
    const { client } = fakeClient({
      workQueue: table === "work_queue" ? [{ id: IDS[0], status }] : [],
      quoteRequests: table === "quote_requests" ? [{ id: IDS[0], status }] : [],
    });

    await expect(collectOperationalEnvelope({ client })).rejects.toThrow(
      "Active operational rows remain.",
    );
  });

  it.each([
    ["missing payload", { data: null, error: null }],
    ["missing controls", { data: {}, error: null }],
    [
      "transport error result",
      { data: null, error: { message: "raw secret" } },
    ],
    [
      "enabled control",
      {
        data: {
          controls: disabledControls().map((control, index) => ({
            ...control,
            enabled: index === 0,
          })),
        },
        error: null,
      },
    ],
    [
      "unknown control",
      {
        data: {
          controls: disabledControls().map((control, index) =>
            index === 0 ? { capability: "unknown", enabled: false } : control,
          ),
        },
        error: null,
      },
    ],
    [
      "duplicate control",
      {
        data: {
          controls: disabledControls().map((control, index, all) =>
            index === 0
              ? { ...control, capability: all[1].capability }
              : control,
          ),
        },
        error: null,
      },
    ],
    [
      "non-boolean state",
      {
        data: {
          controls: disabledControls().map((control, index) =>
            index === 0 ? { ...control, enabled: "false" } : control,
          ),
        },
        error: null,
      },
    ],
  ])("fails closed on %s", async (_label, controls) => {
    const { client } = fakeClient({ controls });
    await expect(collectOperationalEnvelope({ client })).rejects.toThrow();
  });

  it.each([
    ["missing ID", { status: "completed" }],
    ["invalid ID", { id: "customer-id", status: "completed" }],
    ["missing status", { id: IDS[0] }],
    ["unknown status", { id: IDS[0], status: "sleeping" }],
  ])("rejects malformed table row: %s", async (_label, row) => {
    const { client } = fakeClient({ workQueue: [row] });
    await expect(collectOperationalEnvelope({ client })).rejects.toThrow(
      "Invalid table row.",
    );
  });

  it("rejects duplicate/out-of-order IDs and exact-count pagination drift", async () => {
    const duplicate = fakeClient({
      workQueue: [
        { id: IDS[0], status: "completed" },
        { id: IDS[0], status: "failed" },
      ],
    });
    await expect(
      collectOperationalEnvelope({ client: duplicate.client }),
    ).rejects.toThrow("Invalid table row.");

    const drifted = fakeClient({
      workQueue: [
        { id: IDS[0], status: "completed" },
        { id: IDS[1], status: "failed" },
        { id: IDS[2], status: "cancelled" },
      ],
      tableResponse: ({ table, callIndex, rows }) => {
        if (table === "work_queue" && callIndex === 1) {
          return { data: rows.slice(2), count: 2, error: null };
        }
        return undefined;
      },
    });
    await expect(
      collectOperationalEnvelope({ client: drifted.client, pageSize: 2 }),
    ).rejects.toThrow("Table changed or pagination was incomplete.");
  });

  it("rejects same-count ID and status churn between complete scans", async () => {
    const identityChurn = fakeClient({
      workQueue: [
        { id: IDS[0], status: "completed" },
        { id: IDS[1], status: "failed" },
      ],
      tableResponse: ({ table, callIndex }) => {
        if (table !== "work_queue") return undefined;
        const rows =
          callIndex === 0
            ? [
                { id: IDS[0], status: "completed" },
                { id: IDS[1], status: "failed" },
              ]
            : [
                { id: IDS[0], status: "completed" },
                { id: IDS[2], status: "failed" },
              ];
        return { data: rows, count: 2, error: null };
      },
    });
    await expect(
      collectOperationalEnvelope({ client: identityChurn.client }),
    ).rejects.toThrow("Operational envelope did not remain stable.");

    const statusChurn = fakeClient({
      workQueue: [{ id: IDS[0], status: "completed" }],
      tableResponse: ({ table, callIndex }) => {
        if (table !== "work_queue") return undefined;
        return {
          data: [
            {
              id: IDS[0],
              status: callIndex === 0 ? "completed" : "failed",
            },
          ],
          count: 1,
          error: null,
        };
      },
    });
    await expect(
      collectOperationalEnvelope({ client: statusChurn.client }),
    ).rejects.toThrow("Operational envelope did not remain stable.");
  });

  it("rejects control drift at a scan boundary", async () => {
    const { client } = fakeClient({
      controls: ({ callIndex }) => ({
        data: {
          controls: disabledControls().map((control, index) => ({
            ...control,
            enabled: callIndex === 1 && index === 0,
          })),
        },
        error: null,
      }),
    });

    await expect(collectOperationalEnvelope({ client })).rejects.toThrow(
      "Commercial rollout controls are not safely disabled.",
    );
  });

  it("catches an active row inserted after the second table scan", async () => {
    const { client, calls } = fakeClient({
      sentinelResponse: ({ table }) => {
        if (table === "work_queue") {
          return { data: null, count: 1, error: null };
        }
        return undefined;
      },
    });

    await expect(collectOperationalEnvelope({ client })).rejects.toThrow(
      "Active operational rows remain.",
    );
    expect(calls.filter((call) => call.operation === "in")).toEqual([
      {
        operation: "in",
        table: "work_queue",
        column: "status",
        values: ["queued", "running"],
      },
    ]);
  });

  it("catches rollout-control drift after both active sentinels", async () => {
    const { client, calls } = fakeClient({
      controls: ({ callIndex }) => ({
        data: {
          controls: disabledControls().map((control, index) => ({
            ...control,
            enabled: callIndex === 4 && index === 0,
          })),
        },
        error: null,
      }),
    });

    await expect(collectOperationalEnvelope({ client })).rejects.toThrow(
      "Commercial rollout controls are not safely disabled.",
    );
    expect(calls.filter((call) => call.operation === "in")).toHaveLength(2);
    expect(calls.filter((call) => call.operation === "rpc")).toHaveLength(5);
  });

  it("rejects missing exact counts and truncated pages", async () => {
    const missingCount = fakeClient({
      tableResponse: ({ table }) => {
        if (table === "work_queue")
          return { data: [], count: null, error: null };
        return undefined;
      },
    });
    await expect(
      collectOperationalEnvelope({ client: missingCount.client }),
    ).rejects.toThrow("Invalid table count.");

    const truncated = fakeClient({
      workQueue: [
        { id: IDS[0], status: "completed" },
        { id: IDS[1], status: "failed" },
        { id: IDS[2], status: "cancelled" },
      ],
      tableResponse: ({ table, callIndex, rows }) => {
        if (table === "work_queue" && callIndex === 0) {
          return { data: rows.slice(0, 1), count: 3, error: null };
        }
        return undefined;
      },
    });
    await expect(
      collectOperationalEnvelope({ client: truncated.client, pageSize: 2 }),
    ).rejects.toThrow("Table changed or pagination was incomplete.");
  });

  it("rejects malformed or mismatched bindings before requests", async () => {
    const createClientImpl = vi.fn();
    for (const secret of [
      undefined,
      "",
      " secret ",
      "not-a-service-secret",
      "header.not-base64.signature",
      serviceRoleJwt({ ref: "another-project" }),
      serviceRoleJwt({ role: "anon" }),
    ]) {
      await expect(
        collectOperationalEnvelope({
          serviceRoleSecret: secret,
          createClientImpl,
        }),
      ).rejects.toThrow();
    }
    expect(createClientImpl).not.toHaveBeenCalled();

    const mismatched = fakeClient({
      projectUrl: "https://another-project.supabase.co",
    });
    await expect(
      collectOperationalEnvelope({ client: mismatched.client }),
    ).rejects.toThrow("Invalid client binding.");
    expect(mismatched.calls).toEqual([]);

    const unbound = fakeClient();
    delete unbound.client.supabaseUrl;
    delete unbound.client.rest;
    await expect(
      collectOperationalEnvelope({ client: unbound.client }),
    ).rejects.toThrow("Client binding is not authoritative.");
    expect(unbound.calls).toEqual([]);

    const partiallyMismatched = fakeClient();
    partiallyMismatched.client.rest.url =
      "https://another-project.supabase.co/rest/v1";
    await expect(
      collectOperationalEnvelope({ client: partiallyMismatched.client }),
    ).rejects.toThrow("Invalid client binding.");
    expect(partiallyMismatched.calls).toEqual([]);
  });

  it("bounds requests and sanitizes transport failures", async () => {
    const transportSecret = "customer@example.test provider-payload secret-key";
    const failed = fakeClient({
      controls: () => Promise.reject(new Error(transportSecret)),
    });
    const failure = await collectOperationalEnvelope({
      client: failed.client,
    }).catch((error) => error);
    expect(failure.message).toBe("Operational envelope request failed.");
    expect(failure.message).not.toContain(transportSecret);

    let observedSignal;
    const stalled = fakeClient({
      controls: ({ signal }) => {
        observedSignal = signal;
        return new Promise(() => undefined);
      },
    });
    await expect(
      collectOperationalEnvelope({
        client: stalled.client,
        requestTimeoutMs: 5,
        overallTimeoutMs: 50,
      }),
    ).rejects.toThrow("Operational envelope request failed.");
    expect(observedSignal.aborted).toBe(true);
  });

  it("applies one cumulative deadline to a later keyset page", async () => {
    let laterPageSignal;
    const delay = (milliseconds, value) =>
      new Promise((resolve) => setTimeout(() => resolve(value), milliseconds));
    const { client } = fakeClient({
      controls: () =>
        delay(5, {
          data: { controls: disabledControls() },
          error: null,
        }),
      workQueue: [
        { id: IDS[0], status: "completed" },
        { id: IDS[1], status: "failed" },
      ],
      tableResponse: ({ table, callIndex, signal, rows }) => {
        if (table !== "work_queue") return undefined;
        if (callIndex === 0) {
          return delay(5, { data: rows.slice(0, 1), count: 2, error: null });
        }
        laterPageSignal = signal;
        return new Promise(() => undefined);
      },
    });
    const startedAt = Date.now();

    await expect(
      collectOperationalEnvelope({
        client,
        pageSize: 1,
        requestTimeoutMs: 1_000,
        overallTimeoutMs: 25,
      }),
    ).rejects.toThrow("Operational envelope request failed.");

    expect(laterPageSignal.aborted).toBe(true);
    // Well below one per-request budget, while allowing normal CI timer jitter.
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe("OVD-410 operational envelope CLI", () => {
  it("writes exactly one compact deterministic JSON line on success", async () => {
    const output = [];
    const errors = [];
    const envelope = { controls: [], workQueue: {}, quoteRequests: {} };
    const collect = vi.fn().mockResolvedValue(envelope);

    const code = await runOperationalEnvelopeCli({
      args: [],
      env: { SUPABASE_SERVICE_ROLE_KEY: "never-print-this" },
      output: { write: (value) => output.push(value) },
      errorOutput: { write: (value) => errors.push(value) },
      collect,
    });

    expect(code).toBe(0);
    expect(output).toEqual([`${JSON.stringify(envelope)}\n`]);
    expect(errors).toEqual([]);
    expect(collect).toHaveBeenCalledWith({
      serviceRoleSecret: "never-print-this",
    });
  });

  it("emits only a generic failure and no partial JSON", async () => {
    const output = [];
    const errors = [];
    const sensitive = "raw response customer@example.test service-secret";

    const code = await runOperationalEnvelopeCli({
      args: [],
      env: { SUPABASE_SERVICE_ROLE_KEY: sensitive },
      output: { write: (value) => output.push(value) },
      errorOutput: { write: (value) => errors.push(value) },
      collect: vi.fn().mockRejectedValue(new Error(sensitive)),
    });

    expect(code).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      "OVD-410 operational envelope collection failed closed.\n",
    ]);
    expect(errors.join("")).not.toContain(sensitive);
  });

  it("rejects all CLI arguments before collecting", async () => {
    const output = [];
    const errors = [];
    const collect = vi.fn();

    const code = await runOperationalEnvelopeCli({
      args: ["--url", "https://another-project.supabase.co"],
      env: { SUPABASE_SERVICE_ROLE_KEY: "never-print-this" },
      output: { write: (value) => output.push(value) },
      errorOutput: { write: (value) => errors.push(value) },
      collect,
    });

    expect(code).toBe(1);
    expect(collect).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    expect(errors).toEqual([
      "OVD-410 operational envelope collection failed closed.\n",
    ]);
  });
});
