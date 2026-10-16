// @vitest-environment node

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const timingSafeEqualSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
      timingSafeEqualSpy.calls += 1;
      return actual.timingSafeEqual(left, right);
    },
  };
});

import {
  AGENT_API_KEY_SCOPES,
  agentApiKeyHashesMatch,
  hashAgentApiKeySecret,
  isAgentApiKeyScope,
  mintAgentApiKey,
  parseAgentApiKey,
  readBearerToken,
} from "./api-key";

afterEach(() => {
  timingSafeEqualSpy.calls = 0;
});

describe("agent API key format", () => {
  it("mints ovd_<16 hex>_<43 base64url> keys from 256-bit secrets", () => {
    const minted = mintAgentApiKey();
    expect(minted.key).toMatch(/^ovd_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(minted.key.slice(4, 20)).toBe(minted.prefix);
    const secret = minted.key.slice(21);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(minted.keyHash).toBe(createHash("sha256").update(secret, "utf8").digest("hex"));
  });

  it("never repeats prefix or secret across mints", () => {
    const keys = Array.from({ length: 200 }, () => mintAgentApiKey());
    expect(new Set(keys.map((k) => k.prefix)).size).toBe(200);
    expect(new Set(keys.map((k) => k.keyHash)).size).toBe(200);
  });

  it("stores only prefix and hash: the minted hash does not contain the secret", () => {
    const minted = mintAgentApiKey();
    expect(minted.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.keyHash).not.toContain(minted.key.slice(21));
  });

  it("matches the database hash: hex sha256 of the utf8 secret", () => {
    expect(hashAgentApiKeySecret("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("parses a valid key into prefix and secret hash, dropping the plaintext", () => {
    const minted = mintAgentApiKey();
    const parsed = parseAgentApiKey(minted.key);
    expect(parsed).toEqual({ prefix: minted.prefix, secretHash: minted.keyHash });
    expect(JSON.stringify(parsed)).not.toContain(minted.key.slice(21));
  });

  it.each([
    "",
    "ovd_",
    "ovd_0123456789abcdef_short",
    `ovd_0123456789ABCDEF_${"a".repeat(43)}`,
    `ovd_0123456789abcde_${"a".repeat(43)}`,
    `ovd_0123456789abcdef_${"a".repeat(44)}`,
    `ovd_0123456789abcdef_${"a".repeat(42)}+`,
    `xovd_0123456789abcdef_${"a".repeat(43)}`,
    `ovd_0123456789abcdef_${"a".repeat(43)}\n`,
    `sk_0123456789abcdef_${"a".repeat(43)}`,
  ])("rejects malformed key %j", (value) => {
    expect(parseAgentApiKey(value)).toBeNull();
  });

  it("reads Bearer tokens only", () => {
    expect(readBearerToken("Bearer abc")).toBe("abc");
    expect(readBearerToken("bearer abc")).toBe("abc");
    expect(readBearerToken("Basic abc")).toBeNull();
    expect(readBearerToken("Bearer a b")).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
    expect(readBearerToken(`Bearer ${"a".repeat(600)}`)).toBeNull();
  });

  it("has exactly the least-privilege scopes and no admin scope", () => {
    expect(AGENT_API_KEY_SCOPES).toEqual(["quotes:read", "quotes:request"]);
    expect(isAgentApiKeyScope("admin")).toBe(false);
    expect(isAgentApiKeyScope("quotes:*")).toBe(false);
  });
});

describe("constant-time hash comparison", () => {
  it("compares equal digests with timingSafeEqual", () => {
    const hash = hashAgentApiKeySecret("secret");
    expect(agentApiKeyHashesMatch(hash, hash)).toBe(true);
    expect(timingSafeEqualSpy.calls).toBe(1);
  });

  it("compares unequal digests with timingSafeEqual (no early exit on a prefix match)", () => {
    const hash = hashAgentApiKeySecret("secret");
    const lastCharFlipped = `${hash.slice(0, 63)}${hash.endsWith("0") ? "1" : "0"}`;
    expect(agentApiKeyHashesMatch(lastCharFlipped, hash)).toBe(false);
    expect(agentApiKeyHashesMatch("0".repeat(64), hash)).toBe(false);
    expect(timingSafeEqualSpy.calls).toBe(2);
  });

  it("refuses non-digest input without throwing", () => {
    const hash = hashAgentApiKeySecret("secret");
    expect(agentApiKeyHashesMatch("", hash)).toBe(false);
    expect(agentApiKeyHashesMatch(hash.toUpperCase(), hash)).toBe(false);
    expect(agentApiKeyHashesMatch(hash, `${hash}00`)).toBe(false);
  });
});
