/**
 * Jev quote-driver benchmark (docs/jev-quote-driver.md §18). Synthetic pages
 * only: every request is routed to an in-process fixture at
 * https://fixture.invalid and anything else is aborted. Nothing here contacts
 * a provider.
 *
 *   npx tsx src/tools/benchmarkJevDriver.ts [--live] [--modes A,B,C,C0] [--variants v00,v04]
 *     [--reqs r1,r2] [--repeats 1] [--concurrency 3] [--model jev-1.13.0] [--out dir] [--spend-cap-usd 1]
 *
 * Default is replay: Jev answers come from synthetic recordings keyed by the
 * projected-request hash; a miss stops that run with inference_unavailable.
 * --live reads TYPESAFE_API_KEY from the inherited environment, never prints
 * it, and prints only token totals.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { JevTransportError, createJevQuestionsDecider, type JevDriverModel, type QuestionsDecider, type QuestionsResult } from "../jev/questions.js";
import { hashState } from "../jev/driver/projection.js";
import type { DriverOutcome, ModelCallRecord } from "../jev/driver/loop.js";
import { FIXTURE_ORIGIN, FixtureSite, QUOTE_URL } from "./jevDriverBench/fixtureSite.js";
import { driverFactory, productionReadback, runMode, type Mode, type ModeResult, type Readback } from "./jevDriverBench/modes.js";
import { judge, type OracleVerdict } from "./jevDriverBench/oracle.js";
import { ADVERSARIES, adversarialDecider, type Adversary } from "./jevDriverBench/adversarial.js";
import { REQUIREMENTS, VARIANTS, variantSetup, type BenchRequirement, type Variant } from "./jevDriverBench/variants.js";

const PRICE_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;
const PRICE_SOURCE = "docs.typesafe.ai/models (checked 2026-10-23): jev-1.13.0 and jev-1.14.0 $0.042 per 1M input tokens; output free";
const TIMEOUT_MS = 30_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(here, "fixtures", "jev-driver");

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const live = process.argv.includes("--live");
const adversary = arg("adversary", "") as Adversary | "";
if (adversary && !ADVERSARIES.includes(adversary)) throw new Error(`unknown adversary ${adversary}`);
const model = arg("model", "jev-1.13.0") as JevDriverModel;
const modes = arg("modes", "A,B,C").split(",") as Mode[];
const variantFilter = arg("variants", "");
const reqFilter = arg("reqs", "");
const repeats = Number(arg("repeats", "1"));
const concurrency = Number(arg("concurrency", "3"));
const spendCapUsd = Number(arg("spend-cap-usd", "1"));
const outDir = path.resolve(arg("out", path.join("/private/tmp", `jev-driver-bench-${Date.now()}`)));
const replayPath = path.join(FIXTURE_DIR, "replay", `${model}.json`);

type ReplayStore = Record<string, { answers: Record<string, unknown>; inputTokens: number | null; outputTokens: number | null; latencyMs: number }>;
const replay: ReplayStore = existsSync(replayPath) ? JSON.parse(readFileSync(replayPath, "utf8")) as ReplayStore : {};
const recorded: ReplayStore = {};
let spentTokens = 0;
let liveCalls = 0;

function makeDecider(): QuestionsDecider {
  if (adversary) return adversarialDecider(adversary);
  if (!live) {
    return async (request) => {
      const hit = replay[hashState(request)];
      if (!hit) throw new JevTransportError("jev_unavailable");
      return { model, answers: hit.answers, inputTokens: hit.inputTokens, outputTokens: hit.outputTokens, estimatedTokens: 0, requestId: null, latencyMs: hit.latencyMs, requestBytes: 0 };
    };
  }
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("Live run blocked: TYPESAFE_API_KEY unavailable. No inference calls made.");
  const decide = createJevQuestionsDecider(key, model);
  return async (request, signal) => {
    if (spentTokens * PRICE_PER_INPUT_TOKEN_USD >= spendCapUsd) throw new JevTransportError("jev_request_budget");
    const result = await decide(request, signal);
    liveCalls += 1;
    spentTokens += result.inputTokens ?? result.estimatedTokens;
    recorded[hashState(request)] = { answers: result.answers, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
    return result;
  };
}

type RunRow = {
  variant: string; failureClass: string; requirement: string; mode: Mode; repeat: number; model: string | null;
  expect: Variant["expect"]["kind"];
  taskSuccess: boolean; oracleConfigured: boolean; adapterAccepted: boolean; verifiedEndState: boolean; falseSuccess: boolean;
  priceVerified: boolean | null; safeStop: boolean | null; correctStopReason: boolean | null; safetyViolations: string[]; wrongSaves: number;
  outcome: string; stopStep: string | null; handoff: boolean | null;
  scriptedSteps: number; driverActions: number; modelCalls: number; codeDecisions: number; jevDecisions: number;
  inputTokens: number; outputTokens: number; tokensCharged: number; estimatedTokensForCalls: number; costUsd: number;
  segmentMs: number; readbackMs: number; totalMs: number; driverCycleMs: number[]; modelLatencyMs: number[];
  gateHits: Record<string, number>; denyRemovals: number; unexpectedRequests: string[];
  driverStop: { phase: string; reason: string; detail: string; mutationPossible: boolean } | null;
};

function driverOutcomes(result: ModeResult): DriverOutcome[] {
  return [result.driver?.fields, result.driver?.save].filter((outcome): outcome is DriverOutcome => !!outcome);
}

async function runOne(browser: Browser, variant: Variant, requirement: BenchRequirement, mode: Mode, repeat: number, decide: QuestionsDecider, calls: ModelCallRecord[]): Promise<RunRow> {
  const seed = (hashState([variant.id, requirement.id, repeat]).charCodeAt(0) * 7919 + repeat * 104729) >>> 0;
  const { knobs, initial } = variantSetup(variant, requirement, seed);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", timezoneId: "America/Chicago" });
  context.setDefaultTimeout(TIMEOUT_MS);
  context.setDefaultNavigationTimeout(TIMEOUT_MS);
  const site = await FixtureSite.install(context, knobs, initial);
  const page = await context.newPage();
  const started = performance.now();
  let result: ModeResult;
  let readback: Readback = { ran: false, mismatches: [], quantityFailure: null, offers: 0, offerError: null, priceUsd: null, accepted: false, ms: 0 };
  try {
    await page.goto(QUOTE_URL, { waitUntil: "load" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const factory = driverFactory({
      decide, model, modelResolvedSave: true, allowedOrigins: [FIXTURE_ORIGIN], checkpoint: async () => undefined,
      onModelCall: (call) => calls.push(call),
    });
    result = await runMode(mode, page, requirement, TIMEOUT_MS, factory);
    if (!result.finalError) readback = await productionReadback(page, requirement, TIMEOUT_MS);
  } finally {
    await context.close().catch(() => undefined);
  }
  const totalMs = Math.round(performance.now() - started);
  const verdict: OracleVerdict = judge(site, requirement);
  const outcomes = driverOutcomes(result);
  const summary = outcomes.at(-1)?.summary;
  const stopped = outcomes.find((outcome) => outcome.status === "stopped") as Extract<DriverOutcome, { status: "stopped" }> | undefined;
  const tokens = summary?.tokensCharged ?? 0;
  const priceVerified = readback.accepted ? readback.priceUsd !== null && readback.priceUsd === verdict.expectedPriceUsd : null;
  const safe = verdict.safetyViolations.length === 0;
  const configuredExpected = variant.expect.kind === "configured";
  const stopReason = stopped?.reason ?? result.finalError?.code ?? null;
  const correctStopReason = configuredExpected ? null : variant.expect.kind === "stop" && stopReason !== null && variant.expect.reasons.includes(stopReason);
  const safeStop = configuredExpected ? null : !readback.accepted && safe && verdict.wrongSaves === 0;
  const taskSuccess = configuredExpected
    ? verdict.configured && safe && readback.accepted && priceVerified === true && verdict.wrongSaves === 0
    : safeStop === true;
  return {
    variant: variant.id, failureClass: variant.failureClass, requirement: requirement.id, mode, repeat,
    model: mode === "A" ? null : adversary ? `adversarial:${adversary}` : model, expect: variant.expect.kind,
    taskSuccess, oracleConfigured: verdict.configured, adapterAccepted: readback.accepted,
    verifiedEndState: readback.accepted === verdict.configured, falseSuccess: readback.accepted && !verdict.configured,
    priceVerified, safeStop, correctStopReason, safetyViolations: verdict.safetyViolations, wrongSaves: verdict.wrongSaves,
    outcome: result.finalError ? `stopped:${result.finalError.step}:${result.finalError.code ?? "error"}` : readback.accepted ? "quoted" : `readback_failed:${[...readback.mismatches, readback.quantityFailure ?? "", readback.offerError ? "offers" : ""].filter(Boolean).join("+")}`,
    stopStep: result.finalError?.step ?? null, handoff: result.scripted?.handoff ?? null,
    scriptedSteps: result.scripted?.steps.length ?? 0,
    driverActions: summary?.actions ?? 0, modelCalls: summary?.modelCalls ?? 0, codeDecisions: summary?.codeDecisions ?? 0, jevDecisions: summary?.jevDecisions ?? 0,
    inputTokens: summary?.inputTokensReported ?? 0, outputTokens: summary?.outputTokensReported ?? 0, tokensCharged: tokens,
    estimatedTokensForCalls: summary?.estimatedTokensForCalls ?? 0, costUsd: tokens * PRICE_PER_INPUT_TOKEN_USD,
    segmentMs: result.segmentMs, readbackMs: readback.ms, totalMs,
    driverCycleMs: summary?.cycleMs ?? [], modelLatencyMs: summary?.modelLatencyMs ?? [],
    gateHits: summary?.gateHits ?? {}, denyRemovals: summary?.denyRemovals ?? 0, unexpectedRequests: site.unexpectedRequests,
    driverStop: stopped ? { phase: stopped === result.driver?.fields ? "fields" : "save", reason: stopped.reason, detail: stopped.detail, mutationPossible: stopped.mutationPossible } : null,
  };
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function aggregate(rows: RunRow[]) {
  const by = new Map<string, RunRow[]>();
  for (const row of rows) {
    for (const key of [`mode:${row.mode}`, `variant:${row.variant}|mode:${row.mode}`]) {
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(row);
    }
  }
  return Object.fromEntries([...by].map(([key, group]) => [key, {
    runs: group.length,
    taskSuccess: group.filter((row) => row.taskSuccess).length,
    falseSuccess: group.filter((row) => row.falseSuccess).length,
    verifiedEndState: group.filter((row) => row.verifiedEndState).length,
    safetyViolations: group.reduce((total, row) => total + row.safetyViolations.length, 0),
    modelCalls: { median: percentile(group.map((row) => row.modelCalls), 50), p95: percentile(group.map((row) => row.modelCalls), 95), total: group.reduce((t, r) => t + r.modelCalls, 0) },
    driverActions: { median: percentile(group.map((row) => row.driverActions), 50), p95: percentile(group.map((row) => row.driverActions), 95) },
    segmentMs: { median: percentile(group.map((row) => row.segmentMs), 50), p95: percentile(group.map((row) => row.segmentMs), 95) },
    totalMs: { median: percentile(group.map((row) => row.totalMs), 50), p95: percentile(group.map((row) => row.totalMs), 95) },
    inputTokens: { total: group.reduce((t, r) => t + r.inputTokens, 0), median: percentile(group.map((r) => r.inputTokens), 50), p95: percentile(group.map((r) => r.inputTokens), 95), max: Math.max(0, ...group.map((r) => r.inputTokens)) },
    costUsd: { median: percentile(group.map((r) => r.costUsd), 50), p95: percentile(group.map((r) => r.costUsd), 95), max: Math.max(0, ...group.map((r) => r.costUsd)), total: group.reduce((t, r) => t + r.costUsd, 0) },
    modelLatencyMs: { median: percentile(group.flatMap((r) => r.modelLatencyMs), 50), p95: percentile(group.flatMap((r) => r.modelLatencyMs), 95) },
    driverCycleMs: { median: percentile(group.flatMap((r) => r.driverCycleMs), 50), p95: percentile(group.flatMap((r) => r.driverCycleMs), 95) },
  }]));
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const decide = makeDecider();
  const variants = VARIANTS.filter((variant) => !variantFilter || variantFilter.split(",").some((prefix) => variant.id.startsWith(prefix)));
  const requirements = REQUIREMENTS.filter((requirement) => !reqFilter || reqFilter.split(",").includes(requirement.id));
  const jobs: Array<{ variant: Variant; requirement: BenchRequirement; mode: Mode; repeat: number }> = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) for (const variant of variants) for (const requirement of requirements) for (const mode of modes) jobs.push({ variant, requirement, mode, repeat });
  const browser = await chromium.launch({ headless: true });
  const rows: RunRow[] = [];
  const calls: Array<ModelCallRecord & { run: string }> = [];
  let next = 0;
  const startedAt = new Date().toISOString();
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const runCalls: ModelCallRecord[] = [];
      const label = `${job.variant.id}/${job.requirement.id}/${job.mode}/${job.repeat}`;
      try {
        const row = await runOne(browser, job.variant, job.requirement, job.mode, job.repeat, decide, runCalls);
        rows.push(row);
        console.log(`${label} ${row.taskSuccess ? "PASS" : "FAIL"} ${row.outcome} calls=${row.modelCalls} tokens=${row.inputTokens} ${row.segmentMs}ms`);
      } catch (error) {
        console.log(`${label} HARNESS_ERROR ${(error as Error).message.split("\n")[0]}`);
      }
      for (const call of runCalls) calls.push({ ...call, run: label });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  await browser.close();
  rows.sort((a, b) => `${a.variant}${a.requirement}${a.mode}${a.repeat}`.localeCompare(`${b.variant}${b.requirement}${b.mode}${b.repeat}`));
  const report = {
    schema: "jev-driver-benchmark.v1",
    startedAt, finishedAt: new Date().toISOString(),
    inference: adversary ? `adversarial decider '${adversary}' (no inference)` : live ? "live TypeSafe inference on synthetic fixture pages only" : "replay of recorded synthetic responses (no inference)",
    model, engine: `chromium ${browser.version()} (Playwright headless); Camoufox not installed on this host`,
    priceSource: PRICE_SOURCE, timeoutMs: TIMEOUT_MS, concurrency,
    liveCalls, liveInputTokensCharged: spentTokens, liveCostUsd: spentTokens * PRICE_PER_INPUT_TOKEN_USD,
    aggregates: aggregate(rows), rows,
  };
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(outDir, "model-calls.json"), JSON.stringify(calls.map((call) => ({
    run: call.run, subgoal: call.subgoal, requestHash: hashState(call.request), request: call.request,
    answers: call.result?.answers ?? null, error: call.error, inputTokens: call.result?.inputTokens ?? null,
    outputTokens: call.result?.outputTokens ?? null, estimatedTokens: call.result?.estimatedTokens ?? null, latencyMs: call.result?.latencyMs ?? null,
  })), null, 2));
  if (live && Object.keys(recorded).length) {
    mkdirSync(path.dirname(replayPath), { recursive: true });
    writeFileSync(path.join(outDir, `replay-${model}.json`), JSON.stringify({ ...replay, ...recorded }, null, 1));
  }
  console.log(JSON.stringify({ out: outDir, runs: rows.length, liveCalls, liveInputTokensCharged: spentTokens, liveCostUsd: Number((spentTokens * PRICE_PER_INPUT_TOKEN_USD).toFixed(6)) }));
}

void main().catch((error: unknown) => {
  console.error((error as Error).message.split("\n")[0]);
  process.exitCode = 1;
});

export type { QuestionsResult };
