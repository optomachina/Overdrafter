// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import type { VendorAdapter } from "../adapters/base";
import { capturePriceArtifacts } from "../adapters/xometry";
import type { HarnessPriceCapturePage, VendorQuoteAdapterInput, WorkerConfig } from "../types";
import {
  cleanupExpiredLiveHarnessRuns,
  liveHarnessArtifactOptions,
  openLiveHarnessRunArtifacts,
  parseProviderQuoteId,
  stripQuoteUrl,
} from "./liveHarnessArtifacts";
import { parseSmokeArgs, runEvaluationBatch } from "./vendorWorkflowSmoke";

vi.mock("./operatorKillSwitchGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operatorKillSwitchGate")>()),
  assertOperatorProvidersEnabled: vi.fn(async () => undefined),
  guardOperatorQuote: vi.fn((_provider: string, quote: unknown) => quote),
}));

const tempDirs: string[] = [];
const CANARY = [
  "<input name=\"csrf_token\" value=\"canary-secret-value-123\">",
  "<div>Signed in as canary.user@example.com</div>",
  "<div>Authorization: Bearer canaryBearerToken987</div>",
  "<a href=\"https://www.xometry.com/account?session=canary-session-456#frag\">Account</a>",
].join("\n");
const PLACEHOLDER_QUOTE_URL = "https://www.xometry.com/quoting/quote/Q00-0000-0000?token=canary-query#canary-fragment";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function fixturePageHtml() {
  const html = await fs.readFile(new URL("./fixtures/xometry-t1-price-capture.html", import.meta.url), "utf8");
  return html.replace("<!--CANARY-->", CANARY);
}

function fakePage(html: string) {
  const screenshot = vi.fn(async (options: { path: string }) => {
    await fs.writeFile(options.path, "fixture-png-bytes");
  });
  const page = { content: vi.fn(async () => html), screenshot } satisfies HarnessPriceCapturePage & { content(): Promise<string> };
  return { page: page as unknown as Page, screenshot };
}

function expectCanaryRemoved(text: string) {
  expect(text).not.toContain("canary-secret-value-123");
  expect(text).not.toContain("canary.user@example.com");
  expect(text).not.toContain("canaryBearerToken987");
  expect(text).not.toContain("canary-session-456");
  expect(text).not.toContain("canary-query");
  expect(text).not.toContain("canary-fragment");
}

describe("live harness artifact options", () => {
  it("keeps screenshots off unless LIVE_HARNESS_SCREENSHOTS is exactly 1", () => {
    expect(liveHarnessArtifactOptions({}).screenshots).toBe(false);
    expect(liveHarnessArtifactOptions({ LIVE_HARNESS_SCREENSHOTS: "true" }).screenshots).toBe(false);
    expect(liveHarnessArtifactOptions({ LIVE_HARNESS_SCREENSHOTS: "0" }).screenshots).toBe(false);
    expect(liveHarnessArtifactOptions({ LIVE_HARNESS_SCREENSHOTS: "1" }).screenshots).toBe(true);
    expect(liveHarnessArtifactOptions({}).root).toBe(path.join(os.homedir(), "overnight", "artifacts"));
    expect(liveHarnessArtifactOptions({ LIVE_HARNESS_ARTIFACT_ROOT: "/tmp/x" }).root).toBe("/tmp/x");
  });

  it("refuses an artifact root inside the repository", async () => {
    await expect(openLiveHarnessRunArtifacts({ root: process.cwd(), screenshots: false }))
      .rejects.toThrow("outside the repository");
  });

  it("writes no screenshot when the flag is off", async () => {
    const root = await tempDir("live-harness-root-");
    const runArtifacts = await openLiveHarnessRunArtifacts({ root, screenshots: false });
    expect(runArtifacts.screenshotHook("xometry", 10)).toBeUndefined();
    expect((await fs.stat(runArtifacts.runDir)).mode & 0o777).toBe(0o700);
  });
});

describe("quote URL linking", () => {
  it("strips query strings, fragments and userinfo and parses the quote id", () => {
    expect(stripQuoteUrl(PLACEHOLDER_QUOTE_URL)).toBe("https://www.xometry.com/quoting/quote/Q00-0000-0000");
    expect(stripQuoteUrl("https://user:pw@www.xometry.com/quoting/quote/Q00-0000-0000?a=1")).toBe(
      "https://www.xometry.com/quoting/quote/Q00-0000-0000",
    );
    expect(stripQuoteUrl("http://www.xometry.com/quoting/quote/Q00-0000-0000")).toBeNull();
    expect(parseProviderQuoteId(PLACEHOLDER_QUOTE_URL)).toBe("Q00-0000-0000");
    expect(parseProviderQuoteId("https://www.xometry.com/quoting/home?q=/quote/Q00-0000-0000")).toBeNull();
    expect(parseProviderQuoteId(null)).toBeNull();
  });
});

describe("Xometry price capture", () => {
  it("cannot screenshot without an injected hook", async () => {
    const runDir = await tempDir("xometry-price-capture-");
    const { page, screenshot } = fakePage(await fixturePageHtml());
    const artifacts = await capturePriceArtifacts(page, runDir, null);
    expect(screenshot).not.toHaveBeenCalled();
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["html_snapshot"]);
    expect(await fs.readdir(runDir)).toEqual(["price-capture.html"]);
  });

  it("has no screenshot code path in the production adapter source", async () => {
    const source = await fs.readFile(new URL("../adapters/xometry.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.screenshot\s*\(/);
    expect(source).toContain("isLiveEvaluation ? input.harnessPriceCaptureHook ?? null : null");
  });

  it("passes the price-capture DOM through the shared redactor", async () => {
    const runDir = await tempDir("xometry-price-capture-");
    const { page } = fakePage(await fixturePageHtml());
    const [artifact] = await capturePriceArtifacts(page, runDir, null);
    const html = await fs.readFile(artifact!.localPath, "utf8");
    expectCanaryRemoved(html);
    expect(html).toContain("Price and Lead Time");
    expect(artifact!.label).toBe("price-capture-dom");
  });

  it("keeps the quote when an injected hook fails", async () => {
    const runDir = await tempDir("xometry-price-capture-");
    const { page } = fakePage("<html></html>");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const artifacts = await capturePriceArtifacts(page, runDir, async () => {
      throw new Error("disk full");
    });
    expect(artifacts).toHaveLength(1);
  });
});

describe("results.jsonl linking", () => {
  it("links quote id, stripped URL and run-relative artifact paths", async () => {
    const root = await tempDir("live-harness-root-");
    const evidenceDir = await tempDir("live-harness-evidence-");
    const domPath = path.join(evidenceDir, "result.html");
    await fs.writeFile(domPath, `<html>${CANARY}</html>`);
    const runArtifacts = await openLiveHarnessRunArtifacts({ root, screenshots: false });
    const row = await runArtifacts.recordResult({
      provider: "xometry",
      requestedQuantity: 10,
      quoteUrl: PLACEHOLDER_QUOTE_URL,
      status: "instant_quote_received",
      errorCode: null,
      totalPriceUsd: 414.15,
      artifacts: [
        { kind: "html_snapshot", label: "result-dom", localPath: domPath, contentType: "text/html" },
        { kind: "screenshot", label: "elsewhere", localPath: path.join(evidenceDir, "x.png"), contentType: "image/png" },
      ],
      now: new Date("2026-10-15T12:00:00.000Z"),
    });
    const lines = (await fs.readFile(path.join(runArtifacts.runDir, "results.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(row);
    expect(row).toMatchObject({
      runId: runArtifacts.runId,
      provider: "xometry",
      requestedQuantity: 10,
      providerQuoteId: "Q00-0000-0000",
      quoteUrl: "https://www.xometry.com/quoting/quote/Q00-0000-0000",
      timestamp: "2026-10-15T12:00:00.000Z",
      leadTimeBusinessDays: null,
      artifacts: [{
        kind: "html_snapshot",
        label: "result-dom",
        path: `${runArtifacts.runId}/${runArtifacts.runId}-xometry-q10-result-dom.html`,
      }],
    });
    expectCanaryRemoved(lines[0]!);
    expectCanaryRemoved(await fs.readFile(path.join(root, row.artifacts[0]!.path), "utf8"));
  });
});

describe("results.jsonl lead time (OVD-785)", () => {
  async function recordWithLeadTime(leadTimeBusinessDays?: number | null) {
    const root = await tempDir("live-harness-root-");
    const runArtifacts = await openLiveHarnessRunArtifacts({ root, screenshots: false });
    const input = {
      provider: "fictiv",
      requestedQuantity: 1,
      quoteUrl: null,
      status: "instant_quote_received",
      errorCode: null,
      totalPriceUsd: 188,
      artifacts: [],
      now: new Date("2026-10-15T12:00:00.000Z"),
    };
    const row = await runArtifacts.recordResult(
      leadTimeBusinessDays === undefined ? input : { ...input, leadTimeBusinessDays },
    );
    const line = (await fs.readFile(path.join(runArtifacts.runDir, "results.jsonl"), "utf8")).trim();
    return { row, written: JSON.parse(line) };
  }

  it("records the adapter lead time when the caller passes one", async () => {
    const { row, written } = await recordWithLeadTime(7);
    expect(row.leadTimeBusinessDays).toBe(7);
    expect(written.leadTimeBusinessDays).toBe(7);
    expect(written.schemaVersion).toBe("live-harness-run-artifacts.v1");
  });

  it("writes null when the caller omits the lead time", async () => {
    const { written } = await recordWithLeadTime();
    expect(written).toHaveProperty("leadTimeBusinessDays", null);
  });

  it.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])("writes null for invalid lead time %s", async (value) => {
    const { written } = await recordWithLeadTime(value);
    expect(written.leadTimeBusinessDays).toBeNull();
  });
});

describe("retention", () => {
  it("deletes run dirs older than 14 days, keeps newer ones and unrelated entries", async () => {
    const root = await tempDir("live-harness-retention-");
    const oldRun = "20260920T000000Z-0123abcd";
    const newRun = "20261010T000000Z-89abcdef";
    await Promise.all([oldRun, newRun, "operator-notes"].map((name) => fs.mkdir(path.join(root, name))));
    await fs.writeFile(path.join(root, oldRun, "results.jsonl"), "{}\n");
    const now = new Date("2026-10-15T00:00:00.000Z");

    expect(await cleanupExpiredLiveHarnessRuns({ root, now, dryRun: true })).toEqual({
      deleted: [oldRun],
      kept: [newRun],
    });
    expect((await fs.readdir(root)).sort()).toEqual([oldRun, newRun, "operator-notes"].sort());

    await cleanupExpiredLiveHarnessRuns({ root, now });
    expect((await fs.readdir(root)).sort()).toEqual([newRun, "operator-notes"].sort());
  });

  it("applies retention when the harness opens a run", async () => {
    const root = await tempDir("live-harness-retention-");
    await fs.mkdir(path.join(root, "20260101T000000Z-0123abcd"));
    const runArtifacts = await openLiveHarnessRunArtifacts({ root, screenshots: false });
    expect(await fs.readdir(root)).toEqual([runArtifacts.runId]);
  });
});

describe("harness fixture run", () => {
  async function runFixtureBatch(screenshots: boolean) {
    const inputDir = await tempDir("live-harness-input-");
    const root = await tempDir("live-harness-root-");
    const cadPath = path.join(inputDir, "fixture-part.step");
    await fs.writeFile(cadPath, "fixture-cad-bytes");
    const args = parseSmokeArgs([
      "--vendor", "xometry", "--cad", cadPath, "--quantities", "10", "--confirm-non-export-controlled",
    ]);
    const pageHtml = await fixturePageHtml();
    let screenshotCalls = 0;
    let workerTempDir = "";
    const quote = vi.fn<VendorAdapter["quote"]>().mockImplementation(async (input: VendorQuoteAdapterInput) => {
      // Stand-in for the live page: the real adapter capture runs against the T1 fixture DOM.
      const { page, screenshot } = fakePage(pageHtml);
      const runDir = await fs.mkdtemp(path.join(workerTempDir, "xometry-"));
      const artifacts = await capturePriceArtifacts(page, runDir, input.harnessPriceCaptureHook ?? null);
      screenshotCalls += screenshot.mock.calls.length;
      return {
        vendor: "xometry",
        status: "instant_quote_received",
        totalPriceUsd: 414.15,
        unitPriceUsd: 41.42,
        leadTimeBusinessDays: 5,
        quoteUrl: PLACEHOLDER_QUOTE_URL,
        offers: [{
          providerOptionId: "least-expensive",
          providerLabel: "Least Expensive",
          quoteRef: "Q00-0000-0000",
          quoteUrl: PLACEHOLDER_QUOTE_URL,
          unitPriceUsd: 41.42,
          totalPriceUsd: 414.15,
          leadTimeBusinessDays: 5,
          shipReceiveBy: "Nov 6",
          tier: "Least Expensive",
          sourcing: null,
          geographicOrigin: "unknown",
          sortRank: 0,
          provenance: {
            containerSelector: ".price-tier",
            providerOptionIdSource: "label",
            priceSource: "selector",
            leadTimeSource: "selector",
            geographicOriginSource: "none",
          },
          rawPayload: {},
        }],
        rawPayload: {},
        artifacts,
      };
    });
    const rows = await runEvaluationBatch(args, {
      buildRegistry: (config) => {
        workerTempDir = config.workerTempDir;
        return { xometry: { quote } };
      },
      makeVendorConfig: () => ({} as WorkerConfig),
      prepareConfig: async (config) => config,
      runArtifacts: { root, screenshots },
    });
    const [runId] = await fs.readdir(root);
    const runDir = path.join(root, runId!);
    const results = (await fs.readFile(path.join(runDir, "results.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    return { rows, root, runId: runId!, runDir, results, screenshotCalls };
  }

  it("produces linked, redacted artifacts in the artifact root with screenshots on", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { rows, root, runId, runDir, results, screenshotCalls } = await runFixtureBatch(true);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBeNull();
    expect(screenshotCalls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      runId,
      provider: "xometry",
      requestedQuantity: 10,
      providerQuoteId: "Q00-0000-0000",
      quoteUrl: "https://www.xometry.com/quoting/quote/Q00-0000-0000",
      totalPriceUsd: 414.15,
      leadTimeBusinessDays: 5,
    });
    const paths = results[0].artifacts.map((artifact: { path: string }) => artifact.path);
    expect(paths).toEqual([
      `${runId}/${runId}-xometry-q10-price-capture-dom.html`,
      `${runId}/${runId}-xometry-q10-price-capture.png`,
    ]);
    for (const relative of paths) {
      expect(path.basename(relative)).toContain(runId);
      expect((await fs.stat(path.join(root, relative))).mode & 0o777).toBe(0o600);
    }
    expect((await fs.stat(runDir)).mode & 0o777).toBe(0o700);
    expectCanaryRemoved(await fs.readFile(path.join(root, paths[0]), "utf8"));
    expectCanaryRemoved(await fs.readFile(path.join(runDir, "results.jsonl"), "utf8"));
    // The shareable row keeps its existing path redaction.
    expect(JSON.stringify(rows)).not.toContain(root);
  });

  it("writes no screenshot when the flag is off", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { runDir, results, screenshotCalls } = await runFixtureBatch(false);
    expect(screenshotCalls).toBe(0);
    expect((await fs.readdir(runDir)).some((name) => name.endsWith(".png"))).toBe(false);
    expect(results[0].artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual(["html_snapshot"]);
  });
});
