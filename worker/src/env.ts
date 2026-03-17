export function parseEnvBooleanLike(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function parseEnvList(value: unknown, fallback: unknown): string[] {
  const source =
    typeof value === "string" && value.trim().length > 0
      ? value
      : typeof fallback === "string"
        ? fallback
        : "";

  return [...new Set(source.split(",").map((entry) => entry.trim()).filter(Boolean))];
}
