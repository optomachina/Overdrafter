// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import {
  inferProvider,
  buildEvalPromptParts,
  isEvalError,
  createProvider,
} from "./extractEvalProviders.js";
import { estimateCost } from "./extractEvalCosts.js";
import { normalizeComparableFieldValue } from "../extraction/modelFallback.js";

describe("inferProvider", () => {
  it('routes "openai/gpt-4.1-mini" to openrouter (contains slash)', () => {
    expect(inferProvider("openai/gpt-4.1-mini")).toBe("openrouter");
  });

  it('routes "claude-sonnet-4-6" to anthropic (starts with claude-)', () => {
    expect(inferProvider("claude-sonnet-4-6")).toBe("anthropic");
  });

  it('routes "gpt-5.4" to openai (default)', () => {
    expect(inferProvider("gpt-5.4")).toBe("openai");
  });

  it('routes "gpt-4o" to openai (default)', () => {
    expect(inferProvider("gpt-4o")).toBe("openai");
  });

  it("respects override anthropic on any model", () => {
    expect(inferProvider("gpt-5.4", "anthropic")).toBe("anthropic");
  });

  it("respects override openrouter on any model", () => {
    expect(inferProvider("claude-sonnet-4-6", "openrouter")).toBe("openrouter");
  });
});

describe("buildEvalPromptParts", () => {
  it("includes parserContext in userText when provided", () => {
    const ctx = "partNumber: selected=1234 confidence=0.95 reasons=label_match candidates=none";
    const result = buildEvalPromptParts({
      parserContext: ctx,
      baseName: "test-drawing",
      titleBlockCropDataUrl: null,
      fullPageDataUrl: null,
      attempt: "title_block_crop",
    });
    expect(result.userText).toContain("Deterministic parser context:");
    expect(result.userText).toContain(ctx);
  });

  it("omits parserContext section from userText when null", () => {
    const result = buildEvalPromptParts({
      parserContext: null,
      baseName: "test-drawing",
      titleBlockCropDataUrl: null,
      fullPageDataUrl: null,
      attempt: "title_block_crop",
    });
    expect(result.userText).not.toContain("Deterministic parser context:");
  });

  it("includes 1 image when only titleBlockCropDataUrl is present (title_block_crop attempt)", () => {
    const result = buildEvalPromptParts({
      parserContext: null,
      baseName: "test-drawing",
      titleBlockCropDataUrl: "data:image/png;base64,CROP",
      fullPageDataUrl: "data:image/png;base64,FULL",
      attempt: "title_block_crop",
    });
    expect(result.images).toHaveLength(1);
  });

  it("includes 2 images for full_page attempt when both data URLs are provided", () => {
    const result = buildEvalPromptParts({
      parserContext: null,
      baseName: "test-drawing",
      titleBlockCropDataUrl: "data:image/png;base64,CROP",
      fullPageDataUrl: "data:image/png;base64,FULL",
      attempt: "full_page",
    });
    expect(result.images).toHaveLength(2);
  });
});

describe("estimateCost", () => {
  it('calculates cost for known model "gpt-5.4" (1000 input + 500 output)', () => {
    const result = estimateCost("gpt-5.4", 1000, 500);
    expect(result).not.toBeNull();
    // 1000/1M * 2.00 + 500/1M * 8.00 = 0.002 + 0.004 = 0.006
    expect(result!.costUsd).toBeCloseTo(0.006, 10);
    expect(result!.isApproximate).toBe(true); // static table is inherently approximate
  });

  it('calculates cost for known model "claude-sonnet-4-6"', () => {
    const result = estimateCost("claude-sonnet-4-6", 1000, 500);
    expect(result).not.toBeNull();
    // 1000/1M * 3.00 + 500/1M * 15.00 = 0.003 + 0.0075 = 0.0105
    expect(result!.costUsd).toBeCloseTo(0.0105, 10);
  });

  it("returns null for unknown model", () => {
    const result = estimateCost("some-unknown-model", 1000, 500);
    expect(result).toBeNull();
  });
});

describe("normalizeComparableFieldValue", () => {
  it('uppercases "6061-t6" to "6061-T6"', () => {
    expect(normalizeComparableFieldValue("6061-t6")).toBe("6061-T6");
  });

  it('trims and uppercases "  clear anodize  "', () => {
    expect(normalizeComparableFieldValue("  clear anodize  ")).toBe("CLEAR ANODIZE");
  });

  it("returns null for null input", () => {
    expect(normalizeComparableFieldValue(null)).toBeNull();
  });
});

describe("isEvalError", () => {
  it("returns true for object with errorType field", () => {
    const output = {
      modelName: "gpt-5.4",
      errorType: "unknown" as const,
      errorMessage: "Something went wrong",
      durationMs: 100,
    };
    expect(isEvalError(output)).toBe(true);
  });

  it("returns false for object with fields field (success output)", () => {
    const output = {
      fields: {
        partNumber: { value: "1234", confidence: 0.9, fieldSource: "title_block" as const, reasons: [] },
        revision: { value: "A", confidence: 0.9, fieldSource: "title_block" as const, reasons: [] },
        description: { value: "Part", confidence: 0.9, fieldSource: "title_block" as const, reasons: [] },
        material: { value: "6061-T6", confidence: 0.9, fieldSource: "title_block" as const, reasons: [] },
        finish: { value: "Anodize", confidence: 0.9, fieldSource: "title_block" as const, reasons: [] },
        process: { value: "CNC", confidence: 0.9, fieldSource: "title_block" as const, reasons: [] },
        titleBlockSufficient: true,
      },
      modelName: "gpt-5.4",
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 200,
      estimatedCostUsd: null,
      rawResponse: {},
    };
    expect(isEvalError(output)).toBe(false);
  });
});

describe("createProvider — returns null when key missing", () => {
  it("returns null for openai with empty keys", () => {
    expect(createProvider("openai", {})).toBeNull();
  });

  it("returns null for anthropic with empty keys", () => {
    expect(createProvider("anthropic", {})).toBeNull();
  });

  it("returns null for openrouter with empty keys", () => {
    expect(createProvider("openrouter", {})).toBeNull();
  });
});

describe("createProvider — returns provider when key present", () => {
  it("returns provider for openai with key", () => {
    expect(createProvider("openai", { openai: "sk-test" })).not.toBeNull();
  });

  it("returns provider for anthropic with key", () => {
    expect(createProvider("anthropic", { anthropic: "sk-ant-test" })).not.toBeNull();
  });

  it("returns provider for openrouter with key", () => {
    expect(createProvider("openrouter", { openrouter: "sk-or-test" })).not.toBeNull();
  });
});

describe("OpenAIEvalProvider mock test", () => {
  it("OpenAIEvalProvider returns output on success", async () => {
    const { OpenAIEvalProvider } = await import("./extractEvalProviders.js");
    const fakeFields = {
      partNumber: { value: "1234-5678", confidence: 0.95, fieldSource: "title_block", reasons: [] },
      revision: { value: "A", confidence: 0.95, fieldSource: "title_block", reasons: [] },
      description: { value: "Test Part", confidence: 0.95, fieldSource: "title_block", reasons: [] },
      material: { value: "6061-T6", confidence: 0.95, fieldSource: "title_block", reasons: [] },
      finish: { value: "Anodize", confidence: 0.95, fieldSource: "title_block", reasons: [] },
      process: { value: "CNC", confidence: 0.95, fieldSource: "title_block", reasons: [] },
      titleBlockSufficient: true,
    };
    const mockClient = {
      responses: {
        parse: vi.fn().mockResolvedValue({
          output_parsed: fakeFields,
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };
    const provider = new OpenAIEvalProvider(mockClient as never);
    const input = {
      parserContext: null,
      baseName: "test",
      titleBlockCropDataUrl: null,
      fullPageDataUrl: null,
      attempt: "title_block_crop" as const,
    };
    const result = await provider.run(input, "gpt-5.4");
    expect(isEvalError(result)).toBe(false);
    expect(mockClient.responses.parse).toHaveBeenCalledOnce();
    // Verify temperature=0 was set
    expect(mockClient.responses.parse.mock.calls[0][0].temperature).toBe(0);
  });
});

describe("AnthropicEvalProvider mock test", () => {
  it("AnthropicEvalProvider returns output on success", async () => {
    const { AnthropicEvalProvider } = await import("./extractEvalProviders.js");
    const fakeInput = { value: "1234-5678", confidence: 0.95, fieldSource: "title_block", reasons: [] };
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              name: "extract_fields",
              input: {
                partNumber: fakeInput,
                revision: fakeInput,
                description: fakeInput,
                material: fakeInput,
                finish: fakeInput,
                process: fakeInput,
                titleBlockSufficient: true,
              },
            },
          ],
          usage: { input_tokens: 120, output_tokens: 60 },
        }),
      },
    };
    const provider = new AnthropicEvalProvider(mockClient as never);
    const input = {
      parserContext: "context",
      baseName: "test",
      titleBlockCropDataUrl: null,
      fullPageDataUrl: null,
      attempt: "title_block_crop" as const,
    };
    const result = await provider.run(input, "claude-sonnet-4-6");
    expect(isEvalError(result)).toBe(false);
    // Verify tool_choice was set
    const callArg = mockClient.messages.create.mock.calls[0][0];
    expect(callArg.tool_choice).toEqual({ type: "tool", name: "extract_fields" });
    expect(callArg.temperature).toBe(0);
  });
});

describe("OpenRouterEvalProvider mock test", () => {
  it("OpenRouterEvalProvider returns output on success", async () => {
    const { OpenRouterEvalProvider } = await import("./extractEvalProviders.js");
    const fakeField = { value: "X", confidence: 0.9, fieldSource: "title_block", reasons: [] };
    const fakeJson = JSON.stringify({
      partNumber: fakeField,
      revision: fakeField,
      description: fakeField,
      material: fakeField,
      finish: fakeField,
      process: fakeField,
      titleBlockSufficient: true,
    });
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: fakeJson } }],
            usage: { prompt_tokens: 90, completion_tokens: 40 },
          }),
        },
      },
    };
    const provider = new OpenRouterEvalProvider(mockClient as never);
    const input = {
      parserContext: null,
      baseName: "test",
      titleBlockCropDataUrl: null,
      fullPageDataUrl: null,
      attempt: "title_block_crop" as const,
    };
    const result = await provider.run(input, "openai/gpt-4.1-mini");
    expect(isEvalError(result)).toBe(false);
    const callArg = mockClient.chat.completions.create.mock.calls[0][0];
    expect(callArg.temperature).toBe(0);
    expect(callArg.response_format?.type).toBe("json_schema");
  });
});

describe("Error handling — rate limit", () => {
  it("classifies 429 status errors as rate_limit", async () => {
    const { OpenAIEvalProvider } = await import("./extractEvalProviders.js");
    const rateLimitError = Object.assign(new Error("Rate limit exceeded"), { status: 429 });
    const mockClient = {
      responses: {
        parse: vi.fn().mockRejectedValue(rateLimitError),
      },
    };
    const provider = new OpenAIEvalProvider(mockClient as never);
    const input = {
      parserContext: null,
      baseName: "test",
      titleBlockCropDataUrl: null,
      fullPageDataUrl: null,
      attempt: "title_block_crop" as const,
    };
    const result = await provider.run(input, "gpt-5.4");
    expect(isEvalError(result)).toBe(true);
    if (isEvalError(result)) {
      expect(result.errorType).toBe("rate_limit");
    }
  });
});

describe("Error handling — Zod parse failure", () => {
  it("classifies invalid tool_use schema as zod_parse error", async () => {
    const { AnthropicEvalProvider } = await import("./extractEvalProviders.js");
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              name: "extract_fields",
              // Missing required fields — will fail Zod validation
              input: {
                partNumber: { value: "1234" }, // missing confidence, fieldSource, reasons
              },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
      },
    };
    const provider = new AnthropicEvalProvider(mockClient as never);
    const input = {
      parserContext: null,
      baseName: "test",
      titleBlockCropDataUrl: null,
      fullPageDataUrl: null,
      attempt: "title_block_crop" as const,
    };
    const result = await provider.run(input, "claude-sonnet-4-6");
    expect(isEvalError(result)).toBe(true);
    if (isEvalError(result)) {
      expect(result.errorType).toBe("zod_parse");
    }
  });
});
