// @vitest-environment node
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatGptOAuthAuthorizer, chatGptTokenDigest } from "./oauth-bridge";
import { createOverdrafterChatGptServer } from "./tools";
import { createSyntheticChatGptReader, syntheticConnection, syntheticJobId } from "./synthetic-fixture";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it.each(["unchanged", "grant revoked", "session rotated", "grant expired", "expired during connection lookup", "disabled during connection lookup"] as const)(
  "checks completed MCP quote reads against current authorization: %s",
  async (change) => {
    const token = "synthetic-opaque-bearer-".repeat(3);
    const audience = "http://127.0.0.1:8123/mcp";
    const issuer = "https://issuer.example.test";
    const connection = { ...syntheticConnection, scopes: [...syntheticConnection.scopes] };
    let now = 1500;
    let enabled = true;
    let completedRead = false;
    const grant = {
      tokenDigest: chatGptTokenDigest(token), issuer, audience,
      subject: connection.userId, organizationId: connection.organizationId,
      connectionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", revision: "1",
      scopes: ["overdrafter:read"], issuedAtMs: 1000, expiresAtMs: 2000, revoked: false,
    };
    const readCompleted = barrier();
    const returnResult = barrier();
    const authorize = createChatGptOAuthAuthorizer({
      issuer, audience, isEnabled: () => enabled, now: () => now,
      lookupGrant: () => Promise.resolve(grant),
      resolveConnection: async () => {
        if (completedRead && change === "expired during connection lookup") now = grant.expiresAtMs;
        if (completedRead && change === "disabled during connection lookup") enabled = false;
        return connection;
      },
      createReader: (boundConnection) => {
        // Real user-scoped reader with injected synthetic Supabase HTTP responses.
        const reader = createSyntheticChatGptReader(boundConnection);
        return { ...reader, readAuthorizedJob: async (principal, jobId) => {
          const result = await reader.readAuthorizedJob(principal, jobId);
          readCompleted.release();
          await returnResult.promise;
          completedRead = true;
          return result;
        } };
      },
    });
    const dependencies = await authorize(new Request(audience, {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(dependencies).not.toBeNull();
    const server = createOverdrafterChatGptServer(dependencies!);
    const client = new Client({ name: "synthetic-revocation-scenario", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const pending = client.callTool({ name: "list_job_quotes", arguments: { jobId: syntheticJobId } });
      await readCompleted.promise;
      if (change === "grant revoked") grant.revoked = true;
      if (change === "session rotated") connection.accessToken = "rotated-synthetic-session";
      if (change === "grant expired") now = grant.expiresAtMs;
      returnResult.release();
      const result = await pending;
      if (change === "unchanged") {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ quotes: [{ totalPriceUsd: 125 }] });
      } else {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("Synthetic vendor");
        expect(JSON.stringify(result)).not.toContain("totalPriceUsd");
      }
    } finally {
      returnResult.release();
      await client.close();
      await server.close();
    }
  },
);
