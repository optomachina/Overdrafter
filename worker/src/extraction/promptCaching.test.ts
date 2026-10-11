// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { callModel } from "./callModel.js";
import {
  AnthropicExtractionProvider,
  EXTRACTION_PROMPT_CACHE_KEY,
  OpenAIExtractionProvider,
  OpenRouterExtractionProvider,
  type ExtractionProvider,
  type ModelPromptInput,
  type ModelRunResult,
} from "./modelProvider.js";

const PROMPT: ModelPromptInput = {
  parserContext: null,
  baseName: "part",
  titleBlockCropDataUrl: null,
  fullPageDataUrl: null,
  attempt: "title_block_crop",
};

const FIELD = { value: null, confidence: 0, fieldSource: "unknown", reasons: [] };
const FIELDS = {
  partNumber: FIELD,
  revision: FIELD,
  description: FIELD,
  material: FIELD,
  finish: FIELD,
  process: FIELD,
  titleBlockSufficient: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prompt cache key", () => {
  it("is drawing-extraction-v1", () => {
    expect(EXTRACTION_PROMPT_CACHE_KEY).toBe("drawing-extraction-v1");
  });

  it("is sent by the OpenAI provider and maps cached_tokens", async () => {
    const parse = vi.fn().mockResolvedValue({
      output_parsed: FIELDS,
      usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 7 } },
    });
    const provider = new OpenAIExtractionProvider({ responses: { parse } } as never);

    const result = await provider.run(PROMPT, "gpt-4.1-mini");

    expect(parse.mock.calls[0]![0]).toMatchObject({ prompt_cache_key: "drawing-extraction-v1" });
    expect(result).toMatchObject({ cacheReadTokens: 7 });
  });

  it("is sent to OpenRouter openai/* models and maps cached_tokens", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(FIELDS) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
    });
    const provider = new OpenRouterExtractionProvider({ chat: { completions: { create } } } as never);

    const result = await provider.run(PROMPT, "openai/gpt-4.1-mini");

    expect(create.mock.calls[0]![0]).toMatchObject({ prompt_cache_key: "drawing-extraction-v1" });
    expect(result).toMatchObject({ cacheReadTokens: 4 });
  });

  it("is not sent to OpenRouter non-openai models", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(FIELDS) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const provider = new OpenRouterExtractionProvider({ chat: { completions: { create } } } as never);

    await provider.run(PROMPT, "google/gemini-2.5-flash");

    expect(create.mock.calls[0]![0]).not.toHaveProperty("prompt_cache_key");
  });
});

describe("Anthropic prompt caching", () => {
  function anthropicWith(usage: Record<string, unknown>) {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", name: "extract_fields", input: FIELDS }],
      usage: { input_tokens: 10, output_tokens: 5, ...usage },
    });
    return { create, provider: new AnthropicExtractionProvider({ messages: { create } } as never) };
  }

  it("marks the system text block with ephemeral cache_control", async () => {
    const { create, provider } = anthropicWith({});

    await provider.run(PROMPT, "claude-haiku-4-5-20251001");

    const { system } = create.mock.calls[0]![0];
    expect(system).toEqual([
      { type: "text", text: expect.any(String), cache_control: { type: "ephemeral" } },
    ]);
    expect(system[0].text.length).toBeGreaterThan(0);
  });

  it("maps cache read and write token counts", async () => {
    const { provider } = anthropicWith({
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 20,
    });

    expect(await provider.run(PROMPT, "claude-haiku-4-5-20251001")).toMatchObject({
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
    });
  });

  it("keeps zero counts as 0", async () => {
    const { provider } = anthropicWith({
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    expect(await provider.run(PROMPT, "claude-haiku-4-5-20251001")).toMatchObject({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("maps null fields to undefined", async () => {
    const { provider } = anthropicWith({
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });

    const result = await provider.run(PROMPT, "claude-haiku-4-5-20251001");

    expect(result).toMatchObject({ cacheReadTokens: undefined, cacheWriteTokens: undefined });
  });
});

describe("extraction.prompt_cache log", () => {
  function providerReturning(extra: Record<string, number | undefined>): ExtractionProvider {
    const run = vi.fn().mockResolvedValue({
      fields: {},
      modelName: "claude-haiku-4-5-20251001",
      inputTokens: 100,
      outputTokens: 5,
      durationMs: 1,
      estimatedCostUsd: null,
      rawResponse: {},
      ...extra,
    } satisfies Partial<ModelRunResult>);
    return { provider: "anthropic", run } as unknown as ExtractionProvider;
  }

  function cacheLogs(info: ReturnType<typeof vi.spyOn>) {
    return info.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.source === "extraction.prompt_cache");
  }

  it("logs token counts, including explicit zeros", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await callModel(
      providerReturning({ cacheReadTokens: 0, cacheWriteTokens: 0 }),
      PROMPT,
      "claude-haiku-4-5-20251001",
    );

    expect(cacheLogs(info)).toEqual([
      {
        source: "extraction.prompt_cache",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it("defaults the missing side to 0 when only one count is reported", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await callModel(providerReturning({ cacheReadTokens: 42 }), PROMPT, "claude-haiku-4-5-20251001");

    expect(cacheLogs(info)).toMatchObject([{ cacheReadTokens: 42, cacheWriteTokens: 0 }]);
  });

  it("does not log when the provider reports no cache fields", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await callModel(providerReturning({}), PROMPT, "claude-haiku-4-5-20251001");

    expect(cacheLogs(info)).toEqual([]);
  });
});
