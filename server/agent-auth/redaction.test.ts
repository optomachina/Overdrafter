// @vitest-environment node

import { describe, expect, it } from "vitest";
import { mintAgentApiKey } from "./api-key";
import { redactAgentApiKeys, redactAgentApiKeysDeep } from "./redaction";

describe("agent API key redaction", () => {
  it("replaces the secret and keeps the non-secret prefix", () => {
    const { key, prefix } = mintAgentApiKey();
    const redacted = redactAgentApiKeys(`Authorization: Bearer ${key} failed`);
    expect(redacted).toBe(`Authorization: Bearer ovd_${prefix}_[REDACTED] failed`);
    expect(redacted).not.toContain(key.slice(21));
  });

  it("redacts every key, including truncated and URL-embedded ones", () => {
    const a = mintAgentApiKey().key;
    const b = mintAgentApiKey().key;
    const text = `a=${a}&b=${b.slice(0, 30)} "${a}"`;
    const redacted = redactAgentApiKeys(text);
    expect(redacted).not.toContain(a.slice(21));
    expect(redacted).not.toContain(b.slice(21, 30));
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(3);
  });

  it("redacts nested objects, arrays and errors", () => {
    const { key } = mintAgentApiKey();
    const value = redactAgentApiKeysDeep({
      headers: { authorization: `Bearer ${key}` },
      list: [key, 1, null],
      error: new Error(`bad key ${key}`),
    });
    expect(JSON.stringify(value)).not.toContain(key.slice(21));
    expect(value).toMatchObject({ list: [expect.stringContaining("[REDACTED]"), 1, null] });
  });

  it("leaves text without keys unchanged", () => {
    expect(redactAgentApiKeys("ovd_ is a prefix, not a key")).toBe("ovd_ is a prefix, not a key");
  });
});
