// @vitest-environment node

import { describe, expect, it } from "vitest";
import { derivePromptVersion, isModelAttemptSufficient, isModelSignalStrong } from "./policy.js";
import { MODEL_FALLBACK_PROMPT_VERSION } from "./modelFallback.js";

function field(value: string | null, confidence: number, fieldSource: "title_block" | "note" | "unknown" = "title_block") {
  return { value, confidence, fieldSource };
}

function criticalFields(overrides: Partial<Record<string, ReturnType<typeof field>>> = {}) {
  return {
    partNumber: field("1234-5678", 0.95),
    revision: field("A", 0.95),
    description: field("Bracket", 0.95),
    material: field("6061-T6", 0.95),
    finish: field("Anodize", 0.95),
    ...overrides,
  } as never;
}

describe("isModelAttemptSufficient", () => {
  it("accepts an attempt where every critical field is confident and anchored", () => {
    expect(isModelAttemptSufficient(criticalFields())).toBe(true);
  });

  it("rejects an attempt with a missing critical field", () => {
    expect(isModelAttemptSufficient(criticalFields({ finish: field(null, 0.95) }))).toBe(false);
  });

  it("rejects an attempt with a low-confidence critical field", () => {
    expect(isModelAttemptSufficient(criticalFields({ material: field("6061", 0.5) }))).toBe(false);
  });

  it("rejects an attempt whose field could not be located on the drawing", () => {
    expect(
      isModelAttemptSufficient(criticalFields({ revision: field("A", 0.99, "unknown") })),
    ).toBe(false);
  });

  it("ignores process, which is routinely absent from title blocks", () => {
    // process is deliberately not a critical field; a sufficient attempt does
    // not depend on it, so no second full-page call is spent chasing it.
    expect(isModelAttemptSufficient(criticalFields())).toBe(true);
  });
});

describe("isModelSignalStrong", () => {
  it("requires both confidence and a known field source", () => {
    expect(isModelSignalStrong(field("A", 0.9))).toBe(true);
    expect(isModelSignalStrong(field("A", 0.7))).toBe(false);
    expect(isModelSignalStrong(field("A", 0.9, "unknown"))).toBe(false);
  });
});

describe("derivePromptVersion", () => {
  it("is stable for identical prompt content", () => {
    const input = {
      systemInstruction: "sys",
      userInstructions: ["a", "b"] as const,
      schemaShape: "{}",
    };

    expect(derivePromptVersion(input)).toBe(derivePromptVersion(input));
  });

  it("changes when any part of the prompt changes", () => {
    const base = {
      systemInstruction: "sys",
      userInstructions: ["a", "b"] as const,
      schemaShape: "{}",
    };

    expect(derivePromptVersion({ ...base, systemInstruction: "sys2" })).not.toBe(
      derivePromptVersion(base),
    );
    expect(derivePromptVersion({ ...base, userInstructions: ["a", "c"] })).not.toBe(
      derivePromptVersion(base),
    );
    // A schema change alters what the model may answer, so it versions too.
    expect(derivePromptVersion({ ...base, schemaShape: '{"x":1}' })).not.toBe(
      derivePromptVersion(base),
    );
  });

  it("produces the shipped prompt version as a content hash", () => {
    expect(MODEL_FALLBACK_PROMPT_VERSION).toMatch(/^sha256:[0-9a-f]{12}$/);
  });
});
