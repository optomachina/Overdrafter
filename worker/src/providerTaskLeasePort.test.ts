import { describe, expect, it } from "vitest";
import {
  createProviderSessionLeaseManager,
  isProviderSessionIdentity,
  ProviderSessionOutcomeError,
} from "./providerSessionLease";
import { createProviderSessionLeaseMemoryStore } from "./providerSessionLeaseMemoryStore";
import { createProviderTaskLeasePort, parseProviderSessionNamespaceKey } from "./providerTaskLeasePort";
import { loadConfig } from "./config";

const HEX_KEY = "ab".repeat(32);
const KEY = parseProviderSessionNamespaceKey(HEX_KEY)!;

function port(namespaceKey: Uint8Array | null = KEY) {
  const store = createProviderSessionLeaseMemoryStore();
  const manager = createProviderSessionLeaseManager({ store, log: () => undefined });
  return createProviderTaskLeasePort({ manager, namespaceKey });
}

describe("parseProviderSessionNamespaceKey", () => {
  it("accepts hex and base64 keys of at least 32 bytes", () => {
    expect(parseProviderSessionNamespaceKey(HEX_KEY)?.byteLength).toBe(32);
    expect(parseProviderSessionNamespaceKey(Buffer.alloc(48, 7).toString("base64"))?.byteLength).toBe(48);
  });

  it("refuses missing, short, and malformed keys", () => {
    for (const raw of [undefined, null, "", "ab".repeat(31), "a".repeat(65), Buffer.alloc(16).toString("base64"),
      Buffer.alloc(48, 7).toString("base64").slice(0, -1), "not a key!"]) {
      expect(parseProviderSessionNamespaceKey(raw)).toBeNull();
    }
  });
});

describe("createProviderTaskLeasePort", () => {
  it("returns no identity without a namespace key", () => {
    expect(port(null).identity("fictiv", "production")).toBeNull();
  });

  it("derives a stable, valid identity that differs by provider and environment", () => {
    const a = port().identity("fictiv", "production");
    expect(isProviderSessionIdentity(a)).toBe(true);
    expect(port().identity("fictiv", "production")).toEqual(a);
    expect(port().identity("weerg", "production")?.sessionBindingRef).not.toBe(a?.sessionBindingRef);
    expect(port().identity("fictiv", "staging")?.sessionBindingRef).not.toBe(a?.sessionBindingRef);
    expect(JSON.stringify(a)).not.toContain(HEX_KEY);
  });

  it("serializes two tasks on the same binding", async () => {
    const p = port();
    const identity = p.identity("fictiv", "production")!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = p.runWithLease({ identity, taskRef: "task-1" }, () => held.then(() => "first"));
    const second = await p.runWithLease({ identity, taskRef: "task-2" }, async () => "second");
    expect(second.kind).toBe("contended");
    release();
    expect(await first).toEqual({ kind: "completed", value: "first" });
    expect(await p.runWithLease({ identity, taskRef: "task-3" }, async () => "third")).toEqual({
      kind: "completed",
      value: "third",
    });
  });

  it("maps terminal outcomes to lease outcome errors that block the binding", async () => {
    const p = port();
    expect((p.toLeaseError("blocked") as ProviderSessionOutcomeError).outcome).toBe("provider_blocked");
    expect((p.toLeaseError("banned") as ProviderSessionOutcomeError).outcome).toBe("account_banned");
    expect((p.toLeaseError("login_required") as ProviderSessionOutcomeError).outcome).toBe("login_required");
    expect((p.toLeaseError("challenge_required") as ProviderSessionOutcomeError).outcome).toBe("challenge_required");

    const identity = p.identity("fictiv", "production")!;
    await p
      .runWithLease({ identity, taskRef: "task-1" }, async () => {
        throw p.toLeaseError("blocked");
      })
      .catch(() => undefined);
    const after = await p.runWithLease({ identity, taskRef: "task-2" }, async () => "never");
    expect(after).toEqual({ kind: "manual_follow_up", outcome: "provider_blocked" });
  });
});

describe("lease namespace key config", () => {
  const base = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role" };

  it("requires a valid key only when the lease is on", () => {
    expect(loadConfig(base).providerSessionNamespaceKey).toBeNull();
    expect(() => loadConfig({ ...base, WORKER_PROVIDER_SESSION_LEASE: "on" })).toThrow(/NAMESPACE_KEY/);
    expect(() =>
      loadConfig({ ...base, WORKER_PROVIDER_SESSION_LEASE: "on", WORKER_PROVIDER_SESSION_NAMESPACE_KEY: "short" }),
    ).toThrow(/NAMESPACE_KEY/);
    const config = loadConfig({ ...base, WORKER_PROVIDER_SESSION_LEASE: "on", WORKER_PROVIDER_SESSION_NAMESPACE_KEY: HEX_KEY });
    expect(config.providerSessionNamespaceKey?.byteLength).toBe(32);
  });

  it("never echoes the key in the config error", () => {
    const bad = "secret-material!" + "a".repeat(70);
    expect(() =>
      loadConfig({ ...base, WORKER_PROVIDER_SESSION_LEASE: "on", WORKER_PROVIDER_SESSION_NAMESPACE_KEY: bad }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining(bad) }));
  });
});
