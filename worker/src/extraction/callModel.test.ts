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
      { provider: "openai", modelName: "m", inputTokens: 20, outputTokens: 7, durationMs: 150, estimatedCostUsd: 0.02, attempts: 2, costCoverage: "complete" },
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

describe("callModel spend enforcement", () => {
  function guardOf(reserve: ReturnType<typeof vi.fn>, settle: ReturnType<typeof vi.fn>) {
    return { reserve, settle };
  }

  it("reserves before the first attempt and settles the observed cost", async () => {
    const run = vi.fn().mockResolvedValue(success("gpt-4.1-mini"));
    const reserve = vi.fn().mockResolvedValue({ reservationId: "res-1", estimatedUsd: 0.5 });
    const settle = vi.fn().mockResolvedValue(undefined);

    const { usage } = await callModel(providerOf(run), PROMPT, "gpt-4.1-mini", {
      sleep: noSleep,
      spend: { guard: guardOf(reserve, settle), estimatedUsd: 0.5, context: { partId: "p1" } },
    });

    expect(reserve).toHaveBeenCalledWith(
      "llm_extraction",
      0.5,
      expect.objectContaining({ partId: "p1", provider: "openai", modelName: "gpt-4.1-mini" }),
    );
    // Settled to the real cost, not the reserved estimate.
    expect(settle).toHaveBeenCalledWith({ reservationId: "res-1", estimatedUsd: 0.5 }, usage.estimatedCostUsd);
  });

  it("makes no provider request when the reservation is refused", async () => {
    const run = vi.fn().mockResolvedValue(success());
    const reserve = vi.fn().mockRejectedValue(new Error("cap reached"));
    const settle = vi.fn();

    await expect(
      callModel(providerOf(run), PROMPT, "gpt-4.1-mini", {
        sleep: noSleep,
        spend: { guard: guardOf(reserve, settle), estimatedUsd: 0.5 },
      }),
    ).rejects.toThrow("cap reached");

    expect(run).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("preserves unknown cost when an invoked call fails", async () => {
    const run = vi.fn().mockResolvedValue(failure("refusal"));
    const reserve = vi.fn().mockResolvedValue({ reservationId: "res-1", estimatedUsd: 0.5 });
    const settle = vi.fn().mockResolvedValue(undefined);

    await expect(
      callModel(providerOf(run), PROMPT, "gpt-4.1-mini", {
        sleep: noSleep,
        spend: { guard: guardOf(reserve, settle), estimatedUsd: 0.5 },
      }),
    ).rejects.toBeInstanceOf(ModelCallError);

    expect(settle).toHaveBeenCalledWith({ reservationId: "res-1", estimatedUsd: 0.5 }, null);
  });

  it("reserves once for a call that retries internally", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(failure("rate_limit"))
      .mockResolvedValueOnce(success());
    const reserve = vi.fn().mockResolvedValue({ reservationId: "res-1", estimatedUsd: 0.5 });
    const settle = vi.fn().mockResolvedValue(undefined);

    await callModel(providerOf(run), PROMPT, "gpt-4.1-mini", {
      sleep: noSleep,
      random: () => 0,
      spend: { guard: guardOf(reserve, settle), estimatedUsd: 0.5 },
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("skips enforcement entirely when no guard is supplied", async () => {
    const run = vi.fn().mockResolvedValue(success());

    await expect(
      callModel(providerOf(run), PROMPT, "gpt-4.1-mini", { sleep: noSleep }),
    ).resolves.toBeDefined();
  });
});

 describe("attempt cost knowledge", () => {
  function guard() {return {reserve:vi.fn().mockResolvedValue({reservationId:"r",estimatedUsd:0.25}),settle:vi.fn().mockResolvedValue(undefined)};}
  it("counts zero invocations when expired before dispatch and releases zero", async () => {
    const g=guard(),run=vi.fn().mockResolvedValue(success());
    const error=await callModel(providerOf(run),PROMPT,"m",{deadlineMs:0,spend:{guard:g,estimatedUsd:0.25}}).catch(e=>e);
    expect(error.attempts).toBe(0);expect(run).not.toHaveBeenCalled();expect(g.settle).toHaveBeenCalledWith(expect.anything(),0);
  });
  it("preserves the original thrown error if settlement throws", async () => {
    const g=guard();g.settle.mockRejectedValue(new Error("settlement secret"));const original=new Error("provider failed");
    await expect(callModel(providerOf(vi.fn().mockRejectedValue(original)),PROMPT,"m",{spend:{guard:g,estimatedUsd:0.25}})).rejects.toBe(original);
    expect(g.settle).toHaveBeenCalledWith(expect.anything(),null);
  });
  it("marks final success after an uncertain attempt as partial without settling subtotal",async()=>{
    const g=guard();const run=vi.fn().mockResolvedValueOnce(failure("server_error")).mockResolvedValueOnce({...success(),estimatedCostUsd:0.02});
    const result=await callModel(providerOf(run),PROMPT,"m",{sleep:noSleep,random:()=>0,spend:{guard:g,estimatedUsd:0.25}});
    expect(result.usage).toMatchObject({attempts:2,estimatedCostUsd:null,knownCostSubtotalUsd:0.02,costCoverage:"partial"});
    expect(g.settle).toHaveBeenCalledWith(expect.anything(),null);
  });
  it.each([NaN,Infinity,-1])("does not settle malformed provider cost %s",async(cost)=>{
    const g=guard();const result=await callModel(providerOf(vi.fn().mockResolvedValue({...success(),estimatedCostUsd:cost})),PROMPT,"m",{spend:{guard:g,estimatedUsd:0.25}});
    expect(result.usage.estimatedCostUsd).toBeNull();expect(g.settle).toHaveBeenCalledWith(expect.anything(),null);
  });
  it("never presents a partial aggregate as complete",()=>{
    const usage={provider:"openai",modelName:"m",inputTokens:1,outputTokens:1,durationMs:1,attempts:1};
    expect(combineUsage([{...usage,estimatedCostUsd:null},{...usage,estimatedCostUsd:0.02}])).toMatchObject({estimatedCostUsd:null,knownCostSubtotalUsd:0.02,costCoverage:"partial"});
  });
 });

describe("cost validation and outcome isolation", () => {
 it("preserves successful extraction when settlement rejects",async()=>{
  const settle=vi.fn().mockRejectedValue(new Error("private ledger details"));
  const result=await callModel(providerOf(vi.fn().mockResolvedValue(success())),PROMPT,"m",{spend:{guard:{reserve:async()=>({reservationId:"r",estimatedUsd:0.25}),settle},estimatedUsd:0.25}});
  expect(result.usage.costCoverage).toBe("complete");
 });
 it.each([NaN,-1,Infinity])("does not price malformed token usage %s",async(n)=>{
  const result=await callModel(providerOf(vi.fn().mockResolvedValue({...success(),inputTokens:n})),PROMPT,"m");
  expect(result.usage).toMatchObject({estimatedCostUsd:null,costCoverage:"unknown",knownCostSubtotalUsd:null});
 });
 it("keeps an unpriced success unknown instead of using reservation as price",async()=>{
  const settle=vi.fn();
  await callModel(providerOf(vi.fn().mockResolvedValue(success("unregistered"))),PROMPT,"unregistered",{spend:{guard:{reserve:async()=>({reservationId:"r",estimatedUsd:0.25}),settle},estimatedUsd:0.25}});
  expect(settle).toHaveBeenCalledWith(expect.anything(),null);
 });
});

it.each([null,NaN,-1,Infinity,0])("does not label inconsistent subtotal %s a complete aggregate",(subtotal)=>{
 const base={provider:"openai",modelName:"m",inputTokens:1,outputTokens:1,durationMs:1,attempts:1,estimatedCostUsd:0.02};
 expect(combineUsage([{...base,knownCostSubtotalUsd:subtotal},base])?.estimatedCostUsd).toBeNull();
 expect(combineUsage([{...base,costCoverage:"partial"},base])?.estimatedCostUsd).toBeNull();
});

it("retains unknown when aggregate cost overflows",()=>{
 const item={provider:"openai",modelName:"m",inputTokens:1,outputTokens:1,durationMs:1,attempts:1,estimatedCostUsd:Number.MAX_VALUE};
 expect(combineUsage([item,item])).toMatchObject({estimatedCostUsd:null,knownCostSubtotalUsd:null,costCoverage:"unknown"});
});

it("does not promote legacy retry-shaped usage to complete coverage",()=>{
 expect(combineUsage([{provider:"openai",modelName:"m",inputTokens:1,outputTokens:1,durationMs:1,attempts:2,estimatedCostUsd:0.02}])).toMatchObject({estimatedCostUsd:null,knownCostSubtotalUsd:0.02,costCoverage:"partial"});
});
