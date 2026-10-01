// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { chatGptTokenDigest, createChatGptOAuthAuthorizer, type ChatGptGrant } from "./oauth-bridge";
import { syntheticConnection, syntheticJobId } from "./synthetic-fixture";

const token = "a".repeat(64);
const issuer = "https://issuer.example.test";
const audience = "http://127.0.0.1:8123/mcp";
const grant: ChatGptGrant = {
  tokenDigest: chatGptTokenDigest(token), issuer, audience, subject: syntheticConnection.userId,
  organizationId: syntheticConnection.organizationId,
  connectionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", revision: "1",
  scopes: ["overdrafter:read"], issuedAtMs: 1000, expiresAtMs: 2000, revoked: false,
};
function request(authorization = `Bearer ${token}`) {
  return new Request(audience, { headers: { authorization } });
}
function fixture(overrides: Partial<Parameters<typeof createChatGptOAuthAuthorizer>[0]> = {}) {
  const { accessToken: _accessToken, ...principal } = syntheticConnection;
  const reader = {
    isEnabled: () => true,
    resolvePrincipal: vi.fn(() => Promise.resolve(principal)),
    readAuthorizedJob: vi.fn(() => Promise.resolve({ synthetic: true })),
  };
  const options = {
    issuer, audience, now: () => 1500, isEnabled: () => true,
    lookupGrant: vi.fn(() => Promise.resolve(grant)),
    resolveConnection: vi.fn(() => Promise.resolve(syntheticConnection)),
    createReader: vi.fn(() => reader),
    ...overrides,
  };
  return { authorize: createChatGptOAuthAuthorizer(options), options, reader, principal };
}

describe("source-only outer OAuth grant bridge", () => {
  it("is disabled by default before looking up grants or connections", async () => {
    const f = fixture({ isEnabled: undefined });
    expect(await f.authorize(request())).toBeNull();
    expect(f.options.lookupGrant).not.toHaveBeenCalled();
    expect(f.options.resolveConnection).not.toHaveBeenCalled();
  });
  it("accepts mixed-case schemes and uppercase opaque token characters without normalizing the token", async () => {
    const uppercase = token.toUpperCase();
    const f = fixture({ lookupGrant: () => Promise.resolve({ ...grant, tokenDigest: chatGptTokenDigest(uppercase) }) });
    expect(await f.authorize(request(`bEaReR ${uppercase}`))).not.toBeNull();
    expect(await f.authorize(request(`Bearer ${token}`))).toBeNull();
  });
  it("uses only the digest for lookup and never substitutes the outer token for the upstream session", async () => {
    const f = fixture();
    const dependencies = await f.authorize(request());
    expect(dependencies).not.toBeNull();
    expect(f.options.lookupGrant).toHaveBeenCalledWith(chatGptTokenDigest(token));
    expect(f.options.createReader).toHaveBeenCalledWith(syntheticConnection);
    expect(await dependencies!.resolvePrincipal()).toEqual(f.principal);
    expect(await dependencies!.readAuthorizedJob(f.principal, syntheticJobId)).toEqual({ synthetic: true });
    expect(f.options.lookupGrant).toHaveBeenCalledTimes(3);
  });
  it.each(["", "Basic abc", "Bearer short", `Bearer ${token}, Bearer ${token}`, `Bearer  ${token}`])("rejects malformed authorization %s before lookup", async (header) => {
    const f = fixture();
    expect(await f.authorize(request(header))).toBeNull();
    expect(f.options.lookupGrant).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...grant, tokenDigest: "f".repeat(64) }, { ...grant, revoked: true }, { ...grant, expiresAtMs: 1500 },
    { ...grant, issuedAtMs: 1501 }, { ...grant, expiresAtMs: 500 },
    { ...grant, issuer: "https://foreign.example.test" },
    { ...grant, audience: "https://foreign.example.test/mcp" },
    { ...grant, scopes: ["openid"] }, { ...grant, subject: "not-a-uuid" },
  ])("rejects inactive or invalid grants before connection access: %j", async (record) => {
    const f = fixture({ lookupGrant: () => Promise.resolve(record) });
    expect(await f.authorize(request())).toBeNull();
    expect(f.options.resolveConnection).not.toHaveBeenCalled();
  });
  it.each([
    null, { ...syntheticConnection, userId: syntheticJobId },
    { ...syntheticConnection, organizationId: syntheticJobId },
    { ...syntheticConnection, scopes: [] }, { ...syntheticConnection, accessToken: "" },
  ])("rejects absent or mismatched server-held connections", async (connection) => {
    const f = fixture({ resolveConnection: () => Promise.resolve(connection) });
    expect(await f.authorize(request())).toBeNull();
    expect(f.options.createReader).not.toHaveBeenCalled();
  });
  it.each([{ ...grant, revoked: true }, { ...grant, revision: "2" }, { ...grant, subject: syntheticJobId }])("rejects grant changes between HTTP authorization and tool execution", async (changed) => {
    let record = grant;
    const f = fixture({ lookupGrant: () => Promise.resolve(record) });
    const dependencies = await f.authorize(request());
    record = changed;
    expect(await dependencies!.resolvePrincipal()).toBeNull();
    expect(await dependencies!.readAuthorizedJob(f.principal, syntheticJobId)).toBeNull();
    expect(f.reader.resolvePrincipal).not.toHaveBeenCalled();
    expect(f.reader.readAuthorizedJob).not.toHaveBeenCalled();
  });
  it.each([null, { ...syntheticConnection, accessToken: "rotated-synthetic-session" },
    { ...syntheticConnection, scopes: [] }])("rejects deleted, rotated or narrowed connections before tool execution", async (changed) => {
    let connection: typeof syntheticConnection | null = syntheticConnection;
    const f = fixture({ resolveConnection: () => Promise.resolve(connection) });
    const dependencies = await f.authorize(request());
    connection = changed;
    expect(await dependencies!.resolvePrincipal()).toBeNull();
    expect(await dependencies!.readAuthorizedJob(f.principal, syntheticJobId)).toBeNull();
    expect(f.reader.resolvePrincipal).not.toHaveBeenCalled();
    expect(f.reader.readAuthorizedJob).not.toHaveBeenCalled();
  });
  it("rejects a bearer presented to a different resource before lookup", async () => {
    const f = fixture();
    const foreign = new Request("https://foreign.example.test/mcp", { headers: { authorization: `Bearer ${token}` } });
    expect(await f.authorize(foreign)).toBeNull();
    expect(f.options.lookupGrant).not.toHaveBeenCalled();
  });
  it("rejects a reader principal or direct data call outside the grant binding", async () => {
    const f = fixture();
    f.reader.resolvePrincipal.mockResolvedValue({ ...f.principal, userId: syntheticJobId });
    const dependencies = await f.authorize(request());
    expect(await dependencies!.resolvePrincipal()).toBeNull();
    expect(await dependencies!.readAuthorizedJob({ ...f.principal, organizationId: syntheticJobId }, syntheticJobId)).toBeNull();
    expect(f.reader.readAuthorizedJob).not.toHaveBeenCalled();
  });
  it("contains lookup and flag errors without exposing their messages", async () => {
    const failure = () => { throw new Error("private credential"); };
    for (const overrides of [{ lookupGrant: failure }, { isEnabled: failure }]) {
      const f = fixture(overrides);
      expect(await f.authorize(request())).toBeNull();
    }
  });
  it("keeps simultaneous requests bound to their own server connection", async () => {
    const otherToken = "b".repeat(64);
    const other = { ...syntheticConnection, userId: syntheticJobId, accessToken: "other-synthetic-session" };
    const otherGrant = { ...grant, tokenDigest: chatGptTokenDigest(otherToken), subject: other.userId, connectionId: syntheticJobId };
    const createReader = vi.fn((connection: typeof syntheticConnection) => ({
      isEnabled: () => true,
      resolvePrincipal: () => Promise.resolve({ userId: connection.userId, organizationId: connection.organizationId, scopes: connection.scopes }),
      readAuthorizedJob: () => Promise.resolve(null),
    }));
    const f = fixture({
      lookupGrant: (digest) => Promise.resolve(digest === chatGptTokenDigest(token) ? grant : otherGrant),
      resolveConnection: (id) => Promise.resolve(id === grant.connectionId ? syntheticConnection : other), createReader,
    });
    const [one, two] = await Promise.all([f.authorize(request()), f.authorize(request(`Bearer ${otherToken}`))]);
    expect((await one!.resolvePrincipal())?.userId).toBe(syntheticConnection.userId);
    expect((await two!.resolvePrincipal())?.userId).toBe(other.userId);
    expect(createReader).toHaveBeenCalledTimes(2);
  });
});
