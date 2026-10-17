// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAgentApiKey } from "./api-key";
import { InMemoryAgentApiKeyStore } from "./in-memory-repository";
import type { AgentApiKeyRepository } from "./repository";
import { verifyAgentApiKey, type AgentAuthLogger, type VerifyAgentApiKeyOptions } from "./verifier";

const ORG = "00000000-0000-4000-8000-0000008310a0";
const CREATOR = "00000000-0000-4000-8000-000000831a01";
const ADMIN = "00000000-0000-4000-8000-000000831a02";
const T0 = new Date("2026-10-16T12:00:30Z");

let clock: Date;
let store: InMemoryAgentApiKeyStore;
let logs: Array<[string, Readonly<Record<string, unknown>>]>;
let logger: AgentAuthLogger;
let consoleOutput: string[];

beforeEach(() => {
  clock = T0;
  store = new InMemoryAgentApiKeyStore(() => clock);
  store.addMember(ORG, CREATOR);
  store.addMember(ORG, ADMIN, "admin");
  logs = [];
  logger = { warn: (event, fields) => logs.push([event, fields]) };
  consoleOutput = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function create(scopes?: string[], expiresAt?: Date) {
  return store.createKey({ userId: CREATOR, aal: "aal2" }, { orgId: ORG, name: "agent", scopes, expiresAt });
}

function options(overrides: Partial<VerifyAgentApiKeyOptions> = {}): VerifyAgentApiKeyOptions {
  return { repository: store, requiredScope: "quotes:read", endpoint: "quotes.read", logger, now: () => clock, ...overrides };
}

describe("verifyAgentApiKey", () => {
  it("returns org, key id and scopes for a valid key, and audits the use", async () => {
    const created = create();
    const result = await verifyAgentApiKey(`Bearer ${created.key}`, options());
    expect(result).toEqual({ ok: true, orgId: ORG, keyId: created.id, scopes: ["quotes:read"] });
    expect(store.audit.at(-1)).toEqual({
      event: "use", keyId: created.id, orgId: ORG, actorUserId: null, endpoint: "quotes.read", result: "allowed",
    });
    expect(store.storedRows()[0].lastUsedAt).toEqual(T0);
  });

  it.each([
    [undefined, "missing"],
    ["", "missing"],
    ["Basic abc", "malformed"],
    ["Bearer not-a-key", "malformed"],
    [`Bearer ovd_0123456789abcdef_${"a".repeat(42)}`, "malformed"],
  ])("refuses %j as %s with 401 and no database call", async (header, reason) => {
    const repository: AgentApiKeyRepository = {
      getByPrefix: vi.fn(), admitUse: vi.fn(), recordRefusal: vi.fn(),
    };
    expect(await verifyAgentApiKey(header, options({ repository }))).toEqual({ ok: false, reason, status: 401 });
    expect(repository.getByPrefix).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret for a real prefix and audits invalid_secret", async () => {
    const created = create();
    const forged = `ovd_${created.keyPrefix}_${mintAgentApiKey().key.slice(21)}`;
    expect(await verifyAgentApiKey(`Bearer ${forged}`, options())).toEqual({ ok: false, reason: "invalid_key", status: 401 });
    expect(store.audit.at(-1)).toMatchObject({ event: "use", keyId: created.id, result: "invalid_secret" });
  });

  it("refuses an unknown prefix the same way, without an audit row", async () => {
    create();
    const auditBefore = store.audit.length;
    expect(await verifyAgentApiKey(`Bearer ${mintAgentApiKey().key}`, options())).toEqual({
      ok: false, reason: "invalid_key", status: 401,
    });
    expect(store.audit).toHaveLength(auditBefore);
  });

  it("refuses a revoked key on the very next call (no cache)", async () => {
    const created = create();
    expect((await verifyAgentApiKey(`Bearer ${created.key}`, options())).ok).toBe(true);
    store.revokeKey({ userId: CREATOR, aal: "aal2" }, created.id);
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options())).toEqual({ ok: false, reason: "revoked", status: 401 });
    expect(store.audit.at(-1)).toMatchObject({ result: "revoked" });
  });

  it("reads the key on every call", async () => {
    const created = create();
    const getByPrefix = vi.spyOn(store, "getByPrefix");
    for (let i = 0; i < 3; i += 1) {
      await verifyAgentApiKey(`Bearer ${created.key}`, options());
    }
    expect(getByPrefix).toHaveBeenCalledTimes(3);
  });

  it("refuses a key revoked between lookup and admission (database re-check)", async () => {
    const created = create();
    const repository: AgentApiKeyRepository = {
      getByPrefix: (prefix) => store.getByPrefix(prefix),
      admitUse: async (input) => {
        store.revokeKey({ userId: ADMIN, aal: "aal2" }, created.id);
        return store.admitUse(input);
      },
      recordRefusal: (input) => store.recordRefusal(input),
    };
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options({ repository }))).toEqual({
      ok: false, reason: "revoked", status: 401,
    });
  });

  it("refuses an expired key", async () => {
    const created = create(undefined, new Date(T0.getTime() + 1000));
    clock = new Date(T0.getTime() + 1000);
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options())).toEqual({ ok: false, reason: "expired", status: 401 });
    expect(store.audit.at(-1)).toMatchObject({ result: "expired" });
  });

  it("refuses a missing scope with 403 (read-only key cannot request quotes)", async () => {
    const created = create();
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options({ requiredScope: "quotes:request", endpoint: "quotes.request" })))
      .toEqual({ ok: false, reason: "insufficient_scope", status: 403 });
    expect(store.audit.at(-1)).toMatchObject({ endpoint: "quotes.request", result: "insufficient_scope" });
  });

  it("accepts quotes:request only for a key that has it", async () => {
    const created = create(["quotes:read", "quotes:request"]);
    const result = await verifyAgentApiKey(`Bearer ${created.key}`, options({ requiredScope: "quotes:request", endpoint: "quotes.request" }));
    expect(result).toMatchObject({ ok: true, scopes: ["quotes:read", "quotes:request"] });
  });

  it("refuses a key whose creator left the org", async () => {
    const created = create();
    store.removeMember(ORG, CREATOR);
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options())).toEqual({
      ok: false, reason: "creator_not_member", status: 401,
    });
  });

  it("rate limits per key with a retry-after", async () => {
    const created = create();
    const rateLimit = { windowSeconds: 60, perKey: 2, perOrg: 100 };
    expect((await verifyAgentApiKey(`Bearer ${created.key}`, options({ rateLimit }))).ok).toBe(true);
    expect((await verifyAgentApiKey(`Bearer ${created.key}`, options({ rateLimit }))).ok).toBe(true);
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options({ rateLimit }))).toEqual({
      ok: false, reason: "rate_limited", status: 429, retryAfterSeconds: 30,
    });
    clock = new Date(T0.getTime() + 30_000);
    expect((await verifyAgentApiKey(`Bearer ${created.key}`, options({ rateLimit }))).ok).toBe(true);
  });

  it("rate limits per org across keys", async () => {
    const first = create();
    const second = create();
    const rateLimit = { windowSeconds: 60, perKey: 100, perOrg: 2 };
    expect((await verifyAgentApiKey(`Bearer ${first.key}`, options({ rateLimit }))).ok).toBe(true);
    expect((await verifyAgentApiKey(`Bearer ${second.key}`, options({ rateLimit }))).ok).toBe(true);
    expect(await verifyAgentApiKey(`Bearer ${first.key}`, options({ rateLimit }))).toMatchObject({
      ok: false, reason: "rate_limited", status: 429,
    });
    expect(store.audit.at(-1)).toMatchObject({ keyId: first.id, result: "rate_limited_org" });
  });

  it("fails closed with 503 when the lookup or admission is unavailable", async () => {
    const created = create();
    const down: AgentApiKeyRepository = {
      getByPrefix: () => Promise.reject(new Error("connection refused")),
      admitUse: vi.fn(),
      recordRefusal: vi.fn(),
    };
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options({ repository: down }))).toEqual({
      ok: false, reason: "unavailable", status: 503,
    });
    const admitDown: AgentApiKeyRepository = {
      getByPrefix: (prefix) => store.getByPrefix(prefix),
      admitUse: () => Promise.reject(new Error("timeout")),
      recordRefusal: vi.fn(),
    };
    expect(await verifyAgentApiKey(`Bearer ${created.key}`, options({ repository: admitDown }))).toEqual({
      ok: false, reason: "unavailable", status: 503,
    });
  });

  it("rejects a non-bare endpoint name (no URLs or query strings in the audit)", async () => {
    await expect(verifyAgentApiKey("Bearer x", options({ endpoint: "https://x/?key=1" }))).rejects.toThrow(TypeError);
  });
});

describe("plaintext key never leaks", () => {
  it("keeps the key out of logs, console, results, errors and audit on every path", async () => {
    const created = create();
    const secret = created.key.slice(21);
    const forged = `ovd_${created.keyPrefix}_${mintAgentApiKey().key.slice(21)}`;
    const leakyErrors: AgentApiKeyRepository = {
      // An upstream error that echoes the request (worst case) must still be redacted.
      getByPrefix: () => Promise.reject(new Error(`upstream rejected Bearer ${created.key}`)),
      admitUse: vi.fn(),
      recordRefusal: vi.fn(),
    };
    const refusalAuditDown: AgentApiKeyRepository = {
      getByPrefix: (prefix) => store.getByPrefix(prefix),
      admitUse: (input) => store.admitUse(input),
      recordRefusal: () => Promise.reject(new Error(`audit failed for ${created.key}`)),
    };

    const results = [
      await verifyAgentApiKey(`Bearer ${created.key}`, options()),
      await verifyAgentApiKey(`Bearer ${forged}`, options()),
      await verifyAgentApiKey(`Bearer ${forged}`, options({ repository: refusalAuditDown })),
      await verifyAgentApiKey(`Bearer ${created.key}`, options({ requiredScope: "quotes:request" })),
      await verifyAgentApiKey(`Bearer ${created.key}`, options({ repository: leakyErrors })),
      await verifyAgentApiKey(`Bearer ${created.key} extra`, options()),
      await verifyAgentApiKey(`Bearer ${mintAgentApiKey().key}`, options()),
    ];
    store.revokeKey({ userId: CREATOR, aal: "aal2" }, created.id);
    results.push(await verifyAgentApiKey(`Bearer ${created.key}`, options()));

    expect(logs.length).toBeGreaterThan(0);
    const surfaces = [
      JSON.stringify(results),
      JSON.stringify(logs),
      consoleOutput.join("\n"),
      JSON.stringify(store.audit),
      JSON.stringify(store.storedRows()),
      JSON.stringify(store.listKeys({ userId: CREATOR, aal: "aal2" }, ORG)),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(secret);
      expect(surface).not.toContain(created.key);
    }
    expect(JSON.stringify(logs)).toContain(`ovd_${created.keyPrefix}_[REDACTED]`);
  });
});
