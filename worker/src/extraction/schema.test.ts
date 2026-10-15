import { zodTextFormat } from "openai/helpers/zod";
import { describe, expect, it } from "vitest";
import { MODEL_FALLBACK_PROMPT_VERSION } from "./modelFallback.js";
import { modelResponseSchema, strictModelResponseSchema } from "./schema.js";

function collectKeys(value: unknown, keys: Set<string>): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => collectKeys(entry, keys));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

function objectSchemas(value: unknown, found: Array<Record<string, unknown>> = []) {
  if (Array.isArray(value)) value.forEach((entry) => objectSchemas(entry, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "object" && record.properties) found.push(record);
    Object.values(record).forEach((entry) => objectSchemas(entry, found));
  }
  return found;
}

describe("OpenAI strict extraction format", () => {
  const schema = zodTextFormat(strictModelResponseSchema, "drawing_field_extraction").schema;

  it("has no default keywords, which strict structured outputs reject", () => {
    expect(collectKeys(schema, new Set()).has("default")).toBe(false);
  });

  it("requires every property of every object", () => {
    const objects = objectSchemas(schema);
    expect(objects.length).toBeGreaterThan(1);
    for (const object of objects) {
      expect([...(object.required as string[])].sort()).toEqual(
        Object.keys(object.properties as object).sort(),
      );
    }
  });
});

describe("tolerant vs strict parsing", () => {
  const field = { value: "X", confidence: 0.9, fieldSource: "title_block" as const };
  const names = ["partNumber", "revision", "description", "material", "finish", "process"] as const;
  const lenient = Object.fromEntries(names.map((name) => [name, { ...field }]));
  const full = {
    ...Object.fromEntries(names.map((name) => [name, { ...field, reasons: ["r"] }])),
    titleBlockSufficient: false,
  };

  it("keeps defaults for providers parsing via modelResponseSchema", () => {
    const parsed = modelResponseSchema.parse(lenient);
    expect(parsed.titleBlockSufficient).toBe(true);
    for (const name of names) expect(parsed[name].reasons).toEqual([]);
    expect(strictModelResponseSchema.safeParse(lenient).success).toBe(false);
  });

  it("parses a full valid response identically under both schemas", () => {
    expect(strictModelResponseSchema.parse(full)).toEqual(modelResponseSchema.parse(full));
  });
});

describe("prompt version", () => {
  // Must not change for OVD-772: this is the value on main before the strict schema change.
  it("is unchanged", () => {
    expect(MODEL_FALLBACK_PROMPT_VERSION).toBe("sha256:24595ac5e265");
  });
});
