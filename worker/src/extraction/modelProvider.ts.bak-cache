import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { zodTextFormat } from "openai/helpers/zod";
import {
  EXTRACTION_SYSTEM_INSTRUCTION,
  EXTRACTION_USER_INSTRUCTIONS,
  modelResponseSchema,
  type ParsedModelResponse,
} from "./schema.js";
import {
  inferProvider,
  supportsTemperature,
  type ExtractionModelProvider,
} from "./modelRegistry.js";

/**
 * The one place a drawing-extraction request is turned into a provider call.
 *
 * Production, the eval harness, and the debug lab all run through these
 * implementations. That is the point: when the eval harness and production
 * had separate code, the harness ran with deterministic sampling and full
 * usage accounting while production ran with neither, so eval numbers
 * described a configuration no customer ever got.
 */

export type ModelPromptInput = {
  /** Output of serializeParserContext(), or null to withhold parser context. */
  parserContext: string | null;
  baseName: string;
  titleBlockCropDataUrl: string | null;
  fullPageDataUrl: string | null;
  attempt: ModelAttempt;
};

export type ModelAttempt = "title_block_crop" | "full_page";

export type ModelRunOutput = {
  fields: ParsedModelResponse;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Provider-reported cost when available (OpenRouter); otherwise null. */
  estimatedCostUsd: number | null;
  rawResponse: unknown;
};

export type ModelErrorType =
  | "zod_parse"
  | "rate_limit"
  | "transport"
  | "refusal"
  | "missing_tool_call"
  | "timeout"
  | "server_error"
  | "unknown";

export type ModelErrorOutput = {
  modelName: string;
  errorType: ModelErrorType;
  errorMessage: string;
  durationMs: number;
};

export type ModelRunResult = ModelRunOutput | ModelErrorOutput;

export function isModelError(output: ModelRunResult): output is ModelErrorOutput {
  return "errorType" in output;
}

/** Per-request controls owned by callModel, passed through to the SDKs. */
export type ProviderRequestOptions = {
  signal?: AbortSignal;
};

export interface ExtractionProvider {
  readonly provider: ExtractionModelProvider;
  run(
    input: ModelPromptInput,
    modelId: string,
    options?: ProviderRequestOptions,
  ): Promise<ModelRunResult>;
}

export function buildPromptParts(input: ModelPromptInput): {
  systemInstruction: string;
  userText: string;
  images: Array<{ dataUrl: string; detail: "high" }>;
} {
  const textParts = [...EXTRACTION_USER_INSTRUCTIONS, `Filename stem: ${input.baseName}`];
  if (input.parserContext !== null) {
    textParts.push(`Deterministic parser context:\n${input.parserContext}`);
  }

  const images: Array<{ dataUrl: string; detail: "high" }> = [];
  if (input.titleBlockCropDataUrl) {
    images.push({ dataUrl: input.titleBlockCropDataUrl, detail: "high" });
  }
  // A full_page attempt keeps the crop alongside the page so the model can use
  // the legible crop for values and the page for context.
  if (input.attempt === "full_page" && input.fullPageDataUrl) {
    images.push({ dataUrl: input.fullPageDataUrl, detail: "high" });
  }

  return {
    systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
    userText: textParts.join("\n"),
    images,
  };
}

/** Shared JSON schema for one extracted field, for providers without Zod helpers. */
const FIELD_JSON_SCHEMA = {
  type: "object",
  properties: {
    value: { type: ["string", "null"] },
    confidence: { type: "number" },
    fieldSource: { type: "string", enum: ["title_block", "note", "unknown"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["value", "confidence", "fieldSource", "reasons"],
} as const;

const EXTRACTION_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    partNumber: FIELD_JSON_SCHEMA,
    revision: FIELD_JSON_SCHEMA,
    description: FIELD_JSON_SCHEMA,
    material: FIELD_JSON_SCHEMA,
    finish: FIELD_JSON_SCHEMA,
    process: FIELD_JSON_SCHEMA,
    titleBlockSufficient: { type: "boolean" },
  },
  required: [
    "partNumber",
    "revision",
    "description",
    "material",
    "finish",
    "process",
    "titleBlockSufficient",
  ],
};

/** Stable description of the wire schema, for prompt-version hashing. */
export const EXTRACTION_SCHEMA_SHAPE = JSON.stringify(EXTRACTION_TOOL_SCHEMA);

export class OpenAIExtractionProvider implements ExtractionProvider {
  readonly provider = "openai" as const;

  constructor(private readonly client: OpenAI) {}

  async run(
    input: ModelPromptInput,
    modelId: string,
    options: ProviderRequestOptions = {},
  ): Promise<ModelRunResult> {
    const start = Date.now();
    const { systemInstruction, userText, images } = buildPromptParts(input);

    try {
      const content: Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string; detail: "high" }
      > = [{ type: "input_text", text: userText }];

      for (const image of images) {
        content.push({ type: "input_image", image_url: image.dataUrl, detail: "high" });
      }

      const response = await this.client.responses.parse(
        {
          model: modelId,
          ...(supportsTemperature(modelId) ? { temperature: 0 } : {}),
          input: [
            { role: "developer", content: systemInstruction },
            { role: "user", content },
          ],
          text: { format: zodTextFormat(modelResponseSchema, "drawing_field_extraction") },
        },
        { signal: options.signal },
      );

      if (!response.output_parsed) {
        return {
          modelName: modelId,
          errorType: "unknown",
          errorMessage: "No parsed output",
          durationMs: Date.now() - start,
        };
      }

      return {
        fields: response.output_parsed,
        modelName: modelId,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        durationMs: Date.now() - start,
        estimatedCostUsd: null,
        rawResponse: response,
      };
    } catch (error) {
      return classifyError(error, modelId, Date.now() - start);
    }
  }
}

export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly provider = "anthropic" as const;

  constructor(private readonly client: Anthropic) {}

  async run(
    input: ModelPromptInput,
    modelId: string,
    options: ProviderRequestOptions = {},
  ): Promise<ModelRunResult> {
    const start = Date.now();
    const { systemInstruction, userText, images } = buildPromptParts(input);

    try {
      const userContent: Anthropic.MessageParam["content"] = [{ type: "text", text: userText }];
      for (const image of images) {
        const base64 = image.dataUrl.replace(/^data:image\/png;base64,/, "");
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: base64 },
        });
      }

      const response = await this.client.messages.create(
        {
          model: modelId,
          max_tokens: 1024,
          ...(supportsTemperature(modelId) ? { temperature: 0 } : {}),
          system: systemInstruction,
          tools: [
            {
              name: "extract_fields",
              description: "Extract structured title-block fields from an engineering drawing.",
              input_schema: EXTRACTION_TOOL_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: "extract_fields" },
          messages: [{ role: "user", content: userContent }],
        },
        { signal: options.signal },
      );

      const toolUseBlock = response.content.find((block) => block.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        return {
          modelName: modelId,
          errorType: "missing_tool_call",
          errorMessage: "No tool_use block in response",
          durationMs: Date.now() - start,
        };
      }

      const parsed = modelResponseSchema.safeParse(toolUseBlock.input);
      if (!parsed.success) {
        return {
          modelName: modelId,
          errorType: "zod_parse",
          errorMessage: parsed.error.message,
          durationMs: Date.now() - start,
        };
      }

      return {
        fields: parsed.data,
        modelName: modelId,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: Date.now() - start,
        estimatedCostUsd: null,
        rawResponse: response,
      };
    } catch (error) {
      return classifyError(error, modelId, Date.now() - start);
    }
  }
}

export class OpenRouterExtractionProvider implements ExtractionProvider {
  readonly provider = "openrouter" as const;

  constructor(private readonly client: OpenAI) {}

  async run(
    input: ModelPromptInput,
    modelId: string,
    options: ProviderRequestOptions = {},
  ): Promise<ModelRunResult> {
    const start = Date.now();
    const { systemInstruction, userText, images } = buildPromptParts(input);

    try {
      const userContent: Array<{
        type: string;
        text?: string;
        image_url?: { url: string; detail: string };
      }> = [{ type: "text", text: userText }];
      for (const image of images) {
        userContent.push({ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } });
      }

      // OpenRouter is addressed through chat completions rather than the
      // responses API: its coverage of /responses varies by upstream model,
      // while json_schema over chat completions is uniformly supported.
      const response = await this.client.chat.completions.create(
        {
          model: modelId,
          ...(supportsTemperature(modelId) ? { temperature: 0 } : {}),
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: userContent as OpenAI.ChatCompletionContentPart[] },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "drawing_field_extraction",
              strict: true,
              schema: { ...EXTRACTION_TOOL_SCHEMA, additionalProperties: false },
            },
          },
        },
        { signal: options.signal },
      );

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return {
          modelName: modelId,
          errorType: "unknown",
          errorMessage: "Empty response content",
          durationMs: Date.now() - start,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return {
          modelName: modelId,
          errorType: "zod_parse",
          errorMessage: "Response was not valid JSON",
          durationMs: Date.now() - start,
        };
      }

      const zodResult = modelResponseSchema.safeParse(parsed);
      if (!zodResult.success) {
        return {
          modelName: modelId,
          errorType: "zod_parse",
          errorMessage: zodResult.error.message,
          durationMs: Date.now() - start,
        };
      }

      const usageWithCost = response.usage as (typeof response.usage & { cost?: number }) | undefined;

      return {
        fields: zodResult.data,
        modelName: modelId,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - start,
        estimatedCostUsd: typeof usageWithCost?.cost === "number" ? usageWithCost.cost : null,
        rawResponse: response,
      };
    } catch (error) {
      return classifyError(error, modelId, Date.now() - start);
    }
  }
}

export function classifyError(
  error: unknown,
  modelId: string,
  durationMs: number,
): ModelErrorOutput {
  const message = error instanceof Error ? error.message : String(error);
  let errorType: ModelErrorType = "unknown";

  if (error instanceof Error) {
    const status = (error as { status?: number }).status;

    if (error.name === "AbortError" || error.name === "TimeoutError" || /abort|timed? ?out/i.test(message)) {
      errorType = "timeout";
    } else if (status === 429) {
      errorType = "rate_limit";
    } else if (typeof status === "number" && status >= 500) {
      errorType = "server_error";
    } else if (
      message.includes("network") ||
      message.includes("ECONNREFUSED") ||
      message.includes("fetch")
    ) {
      errorType = "transport";
    } else if (
      message.includes("content_policy") ||
      message.includes("refusal") ||
      message.includes("refused")
    ) {
      errorType = "refusal";
    }
  }

  return { modelName: modelId, errorType, errorMessage: message, durationMs };
}

/**
 * Builds a provider client.
 *
 * Retries are disabled on the SDK clients: `callModel` owns retry and the
 * request deadline so that all three providers behave identically instead of
 * each applying its own hidden policy.
 */
export function createProvider(
  provider: ExtractionModelProvider,
  apiKeys: { openai?: string; anthropic?: string; openrouter?: string },
): ExtractionProvider | null {
  switch (provider) {
    case "openai": {
      if (!apiKeys.openai) return null;
      return new OpenAIExtractionProvider(new OpenAI({ apiKey: apiKeys.openai, maxRetries: 0 }));
    }
    case "anthropic": {
      if (!apiKeys.anthropic) return null;
      return new AnthropicExtractionProvider(
        new Anthropic({ apiKey: apiKeys.anthropic, maxRetries: 0 }),
      );
    }
    case "openrouter": {
      if (!apiKeys.openrouter) return null;
      return new OpenRouterExtractionProvider(
        new OpenAI({
          apiKey: apiKeys.openrouter,
          baseURL: "https://openrouter.ai/api/v1",
          maxRetries: 0,
        }),
      );
    }
  }
}

/**
 * Picks the provider for a model id from whichever credentials are configured,
 * falling back to OpenRouter when the model's native provider has no key.
 */
export function resolveProvider(
  modelId: string,
  apiKeys: { openai?: string; anthropic?: string; openrouter?: string },
): { provider: ExtractionProvider; modelId: string } | null {
  const preferred = inferProvider(modelId);
  const direct = createProvider(preferred, apiKeys);

  if (direct) {
    return { provider: direct, modelId };
  }

  if (preferred !== "openrouter" && apiKeys.openrouter) {
    const viaOpenRouter = createProvider("openrouter", apiKeys);
    if (viaOpenRouter) {
      const qualified = modelId.includes("/")
        ? modelId
        : preferred === "anthropic"
          ? `anthropic/${modelId}`
          : `openai/${modelId}`;
      return { provider: viaOpenRouter, modelId: qualified };
    }
  }

  return null;
}
