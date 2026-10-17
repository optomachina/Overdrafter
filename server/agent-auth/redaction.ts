/**
 * Strips agent API key secrets from text and structured values before they
 * reach logs, error reports or analytics. The non-secret prefix is kept so a
 * redacted line can still be matched to a key.
 *
 * It matches anything shaped like `ovd_<hex>_<secret chars>`, including
 * truncated or over-long secrets, so a mangled key is still removed.
 */
const AGENT_API_KEY_LIKE = /\bovd_([0-9a-fA-F]{1,16})_[A-Za-z0-9_-]+/g;
const MAX_DEPTH = 8;

export const AGENT_API_KEY_REDACTED = "[REDACTED]";

export function redactAgentApiKeys(text: string): string {
  return text.replace(AGENT_API_KEY_LIKE, (_match, prefix: string) => `ovd_${prefix}_${AGENT_API_KEY_REDACTED}`);
}

export function redactAgentApiKeysDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactAgentApiKeys(value);
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactAgentApiKeys(value.message) };
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAgentApiKeysDeep(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactAgentApiKeysDeep(item, depth + 1)]),
  );
}
