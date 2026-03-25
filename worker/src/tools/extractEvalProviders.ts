import { z } from "zod";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { zodTextFormat } from "openai/helpers/zod";
import {
  modelResponseSchema,
  serializeParserContext,
  imageFileToDataUrl,
  EXTRACTION_SYSTEM_INSTRUCTION,
  EXTRACTION_USER_INSTRUCTIONS,
  type ParsedModelResponse,
} from "../extraction/modelFallback.js";
import type { ExtractedDrawingSignals } from "../extraction/pdfDrawing.js";

export type EvalModelInput = {
  parserContext: string | null; // output of serializeParserContext(), or null if --no-parser
  baseName: string;
  titleBlockCropDataUrl: string | null;
  fullPageDataUrl: string | null;
  attempt: "title_block_crop" | "full_page";
};

export type EvalModelOutput = {
  fields: ParsedModelResponse;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCostUsd: number | null; // null = use static table; set for OpenRouter (provider-reported)
  rawResponse: unknown;
};

export type EvalErrorOutput = {
  modelName: string;
  errorType: "zod_parse" | "rate_limit" | "transport" | "refusal" | "missing_tool_call" | "timeout" | "unknown";
  errorMessage: string;
  durationMs: number;
};

export type EvalRunOutput = EvalModelOutput | EvalErrorOutput;

export function isEvalError(output: EvalRunOutput): output is EvalErrorOutput {
  return "errorType" in output;
}

export function buildEvalPromptParts(input: EvalModelInput): {
  systemInstruction: string;
  userText: string;
  images: Array<{ dataUrl: string; detail: "high" }>;
} {
  const textParts = [
    ...EXTRACTION_USER_INSTRUCTIONS,
    `Filename stem: ${input.baseName}`,
  ];
  if (input.parserContext !== null) {
    textParts.push(`Deterministic parser context:\n${input.parserContext}`);
  }

  const images: Array<{ dataUrl: string; detail: "high" }> = [];
  if (input.titleBlockCropDataUrl) {
    images.push({ dataUrl: input.titleBlockCropDataUrl, detail: "high" });
  }
  // full_page attempt includes both crop AND full page (matching production behavior)
  if (input.attempt === "full_page" && input.fullPageDataUrl) {
    images.push({ dataUrl: input.fullPageDataUrl, detail: "high" });
  }

  return {
    systemInstruction: EXTRACTION_SYSTEM_INSTRUCTION,
    userText: textParts.join("\n"),
    images,
  };
}

export function inferProvider(
  modelId: string,
  override?: string,
): "openai" | "anthropic" | "openrouter" {
  if (override === "openai" || override === "anthropic" || override === "openrouter") {
    return override;
  }
  if (modelId.includes("/")) return "openrouter";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (override) {
    console.warn(`Unknown --provider "${override}", defaulting to openai`);
  } else {
    console.warn(`Unknown model "${modelId}" — routing to OpenAI; add to cost table if needed`);
  }
  return "openai";
}

export interface EvalProvider {
  run(input: EvalModelInput, modelId: string): Promise<EvalRunOutput>;
}

export class OpenAIEvalProvider implements EvalProvider {
  constructor(private readonly client: OpenAI) {}

  async run(input: EvalModelInput, modelId: string): Promise<EvalRunOutput> {
    const start = Date.now();
    const { systemInstruction, userText, images } = buildEvalPromptParts(input);

    try {
      const content: Array<
        | { type: "input_text"; text: string }
        | { type: "input_image"; image_url: string; detail: "high" }
      > = [{ type: "input_text", text: userText }];

      for (const img of images) {
        content.push({ type: "input_image", image_url: img.dataUrl, detail: "high" });
      }

      const response = await this.client.responses.parse({
        model: modelId,
        temperature: 0,
        input: [
          { role: "developer", content: systemInstruction },
          { role: "user", content },
        ],
        text: { format: zodTextFormat(modelResponseSchema, "drawing_field_extraction") },
      });

      if (!response.output_parsed) {
        return { modelName: modelId, errorType: "unknown", errorMessage: "No parsed output", durationMs: Date.now() - start };
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
    } catch (err) {
      const durationMs = Date.now() - start;
      return classifyError(err, modelId, durationMs);
    }
  }
}

export class AnthropicEvalProvider implements EvalProvider {
  constructor(private readonly client: Anthropic) {}

  async run(input: EvalModelInput, modelId: string): Promise<EvalRunOutput> {
    const start = Date.now();
    const { systemInstruction, userText, images } = buildEvalPromptParts(input);

    try {
      const userContent: Anthropic.MessageParam["content"] = [
        { type: "text", text: userText },
      ];
      for (const img of images) {
        const base64 = img.dataUrl.replace(/^data:image\/png;base64,/, "");
        userContent.push({ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } });
      }

      const response = await this.client.messages.create({
        model: modelId,
        max_tokens: 1024,
        temperature: 0,
        system: systemInstruction,
        tools: [
          {
            name: "extract_fields",
            description: "Extract structured title-block fields from an engineering drawing.",
            input_schema: {
              type: "object" as const,
              properties: {
                partNumber: { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string", enum: ["title_block", "note", "unknown"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                revision:   { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string", enum: ["title_block", "note", "unknown"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                description:{ type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string", enum: ["title_block", "note", "unknown"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                material:   { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string", enum: ["title_block", "note", "unknown"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                finish:     { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string", enum: ["title_block", "note", "unknown"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                process:    { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string", enum: ["title_block", "note", "unknown"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                titleBlockSufficient: { type: "boolean" },
              },
              required: ["partNumber", "revision", "description", "material", "finish", "process", "titleBlockSufficient"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "extract_fields" },
        messages: [{ role: "user", content: userContent }],
      });

      const toolUseBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        return { modelName: modelId, errorType: "missing_tool_call", errorMessage: "No tool_use block in response", durationMs: Date.now() - start };
      }

      const parsed = modelResponseSchema.safeParse(toolUseBlock.input);
      if (!parsed.success) {
        return { modelName: modelId, errorType: "zod_parse", errorMessage: parsed.error.message, durationMs: Date.now() - start };
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
    } catch (err) {
      return classifyError(err, modelId, Date.now() - start);
    }
  }
}

export class OpenRouterEvalProvider implements EvalProvider {
  constructor(private readonly client: OpenAI) {}

  async run(input: EvalModelInput, modelId: string): Promise<EvalRunOutput> {
    const start = Date.now();
    const { systemInstruction, userText, images } = buildEvalPromptParts(input);

    try {
      const userContent: Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }> = [
        { type: "text", text: userText },
      ];
      for (const img of images) {
        userContent.push({ type: "image_url", image_url: { url: img.dataUrl, detail: "high" } });
      }

      const response = await this.client.chat.completions.create({
        model: modelId,
        temperature: 0,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userContent as OpenAI.ChatCompletionContentPart[] },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "drawing_field_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                partNumber: { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string" }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                revision:   { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string" }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                description:{ type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string" }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                material:   { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string" }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                finish:     { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string" }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                process:    { type: "object", properties: { value: { type: ["string", "null"] }, confidence: { type: "number" }, fieldSource: { type: "string" }, reasons: { type: "array", items: { type: "string" } } }, required: ["value", "confidence", "fieldSource", "reasons"] },
                titleBlockSufficient: { type: "boolean" },
              },
              required: ["partNumber", "revision", "description", "material", "finish", "process", "titleBlockSufficient"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return { modelName: modelId, errorType: "unknown", errorMessage: "Empty response content", durationMs: Date.now() - start };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { modelName: modelId, errorType: "zod_parse", errorMessage: "Response was not valid JSON", durationMs: Date.now() - start };
      }

      const zodResult = modelResponseSchema.safeParse(parsed);
      if (!zodResult.success) {
        return { modelName: modelId, errorType: "zod_parse", errorMessage: zodResult.error.message, durationMs: Date.now() - start };
      }

      // Use provider-reported cost from OpenRouter if available
      const usageAny = response.usage as (typeof response.usage & { cost?: number }) | undefined;
      const estimatedCostUsd = typeof usageAny?.cost === "number" ? usageAny.cost : null;

      return {
        fields: zodResult.data,
        modelName: modelId,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - start,
        estimatedCostUsd,
        rawResponse: response,
      };
    } catch (err) {
      return classifyError(err, modelId, Date.now() - start);
    }
  }
}

function classifyError(err: unknown, modelId: string, durationMs: number): EvalErrorOutput {
  const message = err instanceof Error ? err.message : String(err);
  let errorType: EvalErrorOutput["errorType"] = "unknown";
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    if (status === 429) errorType = "rate_limit";
    else if (message.includes("network") || message.includes("ECONNREFUSED") || message.includes("fetch")) errorType = "transport";
    else if (message.includes("content_policy") || message.includes("refusal") || message.includes("refused")) errorType = "refusal";
  }
  return { modelName: modelId, errorType, errorMessage: message, durationMs };
}

export function createProvider(
  provider: "openai" | "anthropic" | "openrouter",
  apiKeys: { openai?: string; anthropic?: string; openrouter?: string },
): EvalProvider | null {
  switch (provider) {
    case "openai": {
      if (!apiKeys.openai) return null;
      return new OpenAIEvalProvider(new OpenAI({ apiKey: apiKeys.openai }));
    }
    case "anthropic": {
      if (!apiKeys.anthropic) return null;
      return new AnthropicEvalProvider(new Anthropic({ apiKey: apiKeys.anthropic }));
    }
    case "openrouter": {
      if (!apiKeys.openrouter) return null;
      return new OpenRouterEvalProvider(
        new OpenAI({ apiKey: apiKeys.openrouter, baseURL: "https://openrouter.ai/api/v1" }),
      );
    }
  }
}

// Re-export for convenience of eval harness consumers
export { serializeParserContext, imageFileToDataUrl };
export type { ExtractedDrawingSignals };
