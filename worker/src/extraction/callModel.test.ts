// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { callModel, combineUsage, ModelCallError, retryDelayMs } from "./callModel.js";
import type { ExtractionProvider, ModelPromptInput, ModelRunResult } from "./modelProvider.js";

const PROMPT: ModelPromptInput = {
  parserContext: null,
  baseName: "part",
  titleBlockCropDataUrl: null,
  fullPageDataUrl: null,
  attempt: "title_block_crop",
};

function success(modelName = "gpt-4.1-mini"): ModelRunResult {
  return {
    fields: {} as never,
    modelName,
    inputTokens: 1_000,
    outputTokens: 500,
    durationMs: 5,
    estimatedCostUsd: null,
    rawResponse: {},
  };
}

function failure(errorType: "rate_limit" | "refusal" | "server_error"): ModelRunResult {
  return { modelName: "gpt-4.1-mini", errorType, errorMessage: errorType, durationMs: 1 };
}

function providerOf(run: (...args: never[]) => Promise<ModelRunResult>): ExtractionProvider {
  return { provider: "openai", run } as unknown as ExtractionProvider;
}

const noSleep = async () => {};

describe("callModel", () => {
  it("returns usage on first success", async () => {
    const run = vi.fn().mockResolvedValue(success());

    const { usage } = await callModel(providerOf(run), PROMPT, "gpt-4.1-mini", { sleep: noSleep });

    expect(run).toHaveBeenCalledTimes(1);
    expect(usage).toMatchObject({ provider: "openai", inputTokens: 1_000, outputTokens: 500, attempts: 1 });
  });

  it("prices a call from the registry when the provider reports no cost", async () => {
    const run = vi.fn().mockResolvedValue(success("gpt-4.1-mini"));

    const { usage } = await callModel(providerOf(run), PROMPT, "gpt-4.1-mini", { sleep: noSleep });

    // 1000 in @ $0.15/1M + 500 out @ $0.60/1M
    expect(usage.estimatedCostUsd).toBeCloseTo(0.00045, 8);
  });

  it("retries a rate limit and reports the attempt count", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(failure("rate_limit"))
      .mockResolvedValueOnce(success());

    const { usage } = await callModel(providerOf(run), PROMPT, "gpt-4.1-mini", {
      sleep: noSleep,
      random: () => 0,
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(usage.attempts).toBe(2);
  });

  it("does not retry a non-transient failure", async () => {
    const run = vi.fn().mockResolvedValue(failure("refusal"));

    await expect(
      callModel(providerOf(run), PROMPT, "gpt-4.1-mini", { sleep: noSleep }),
    ).rejects.toBeInstanceOf(ModelCallError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and surfaces the last error type", async () => {
    const run = vi.fn().mockResolvedValue(failure("server_error"));

    const error = await callModel(providerOf(run), PROMPT, "gpt-4.1-mini", {
      sleep: noSleep,
      random: () => 0,
      maxAttempts: 3,
    }).catch((caught: unknown) => caught as ModelCallError);

    expect(run).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).errorType).toBe("server_error");
    expect((error as ModelCallError).attempts).toBe(3);
  });

  it("passes an abort signal so a hung provider cannot stall the worker", async () => {
    const run = vi.fn().mockResolvedValue(success());

    await callModel(providerOf(run), PROMPT, "gpt-4.1-mini", { sleep: noSleep });

    const options = run.mock.calls[0][2] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops retrying once the deadline is spent", async () => {
    const run = vi.fn().mockImplementation(async () => failure("rate_limit"));

    await expect(
      callModel(providerOf(run), PROMPT, "gpt-4.1-mini", {
        sleep: noSleep,
        random: () => 1,
        maxAttempts: 10,
        deadlineMs: 1,
      }),
    ).rejects.toBeInstanceOf(ModelCallError);

    expect(run.mock.calls.length).toBeLessThan(10);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially and stays bounded", () => {
    expect(retryDelayMs(1, () => 1)).toBe(500);
    expect(retryDelayMs(2, () => 1)).toBe(1_000);
    expect(retryDelayMs(9, () => 1)).toBe(8_000);
  });

  it("applies full jitter so parallel lanes do not retry in lockstep", () => {
    expect(retryDelayMs(3, () => 0)).toBe(0);
    expect(retryDelayMs(3, () => 0.5)).toBe(1_000);
  });
});

describe("combineUsage", () => {
  it("sums tokens, time, and attempts across attempts", () => {
    const combined = combineUsage([
      { provider: "openai", modelName: "m", inputTokens: 10, outputTokens: 5, durationMs: 100, estimatedCostUsd: 0.01, attempts: 1 },
      { provider: "openai", modelName: "m", inputTokens: 20, outputTokens: 7, durationMs: 150, estimatedCostUsd: 0.02, attempts: 2 },
    ]);

    expect(combined).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      durationMs: 250,
      estimatedCostUsd: 0.03,
      attempts: 3,
    });
  });

  it("returns null cost when no attempt could be priced", () => {
    const combined = combineUsage([
      { provider: "openai", modelName: "m", inputTokens: 10, outputTokens: 5, durationMs: 100, estimatedCostUsd: null, attempts: 1 },
    ]);

    expect(combined?.estimatedCostUsd).toBeNull();
  });

  it("returns null for no attempts", () => {
    expect(combineUsage([])).toBeNull();
  });
});
