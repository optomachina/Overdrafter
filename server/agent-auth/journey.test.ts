// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AgentApiKeyRequestError, InMemoryAgentApiKeyStore } from "./in-memory-repository";
import { verifyAgentApiKey } from "./verifier";

/**
 * OVD-831 journey (OVD-825 style), service level. This slice ships no UI or
 * route, and the database draft is not applied, so the journey runs against
 * the in-memory store that mirrors the draft's RPC rules. When the S5/S6
 * routes and a key-management page land, a browser journey replaces this:
 * create key -> see it once -> call an agent route -> revoke -> call fails.
 */
describe("journey: user creates an agent key, sees it once, revokes it", () => {
  const ORG = "00000000-0000-4000-8000-0000008310a0";
  const USER = { userId: "00000000-0000-4000-8000-000000831a01", aal: "aal2" as const };

  it("works end to end and the revoked key then fails", async () => {
    const store = new InMemoryAgentApiKeyStore();
    store.addMember(ORG, USER.userId);
    const verify = (header: string) =>
      verifyAgentApiKey(header, { repository: store, requiredScope: "quotes:read", endpoint: "quotes.read" });

    // A step-up (AAL2) session is required to create.
    expect(() => store.createKey({ ...USER, aal: "aal1" }, { orgId: ORG, name: "CI agent" }))
      .toThrow(new AgentApiKeyRequestError("aal2_required"));

    // Create: the plaintext key is in the create response only.
    const created = store.createKey(USER, { orgId: ORG, name: "CI agent" });
    expect(created.key).toMatch(/^ovd_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(created.scopes).toEqual(["quotes:read"]);
    expect(created.expiresAt.getTime() - created.createdAt.getTime()).toBe(90 * 86_400_000);

    // See it once: listing shows prefix, name and scopes, never the key or hash.
    const listed = store.listKeys(USER, ORG);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: created.id, keyPrefix: created.keyPrefix, name: "CI agent", revokedAt: null });
    expect(JSON.stringify(listed)).not.toContain(created.key.slice(21));
    expect(listed[0]).not.toHaveProperty("keyHash");
    expect(JSON.stringify(store.storedRows())).not.toContain(created.key.slice(21));

    // The agent uses it.
    expect(await verify(`Bearer ${created.key}`)).toEqual({ ok: true, orgId: ORG, keyId: created.id, scopes: ["quotes:read"] });

    // Revoke needs AAL2 too, then takes effect immediately.
    expect(() => store.revokeKey({ ...USER, aal: "aal1" }, created.id)).toThrow(new AgentApiKeyRequestError("aal2_required"));
    expect(store.revokeKey(USER, created.id).alreadyRevoked).toBe(false);
    expect(store.listKeys(USER, ORG)[0].revokedAt).not.toBeNull();
    expect(await verify(`Bearer ${created.key}`)).toEqual({ ok: false, reason: "revoked", status: 401 });

    // Audit trail: create, use, revoke, refused use. No key material.
    expect(store.audit.map((event) => `${event.event}:${event.result}`)).toEqual([
      "create:created", "use:allowed", "revoke:revoked", "use:revoked",
    ]);
    expect(JSON.stringify(store.audit)).not.toContain(created.key.slice(21));
  });
});
