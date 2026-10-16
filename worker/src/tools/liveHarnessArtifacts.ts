import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactProviderPortalHtml } from "../adapters/providerEvidenceRedaction.js";
import type { HarnessPriceCaptureHook, VendorArtifact } from "../types.js";

/**
 * OVD-779: operator-local per-run artifacts for the live-provider evaluation
 * harness. Everything here stays on the operator machine under the artifact
 * root; nothing is uploaded to Supabase, CI, Linear or GitHub.
 */

export const LIVE_HARNESS_SCREENSHOTS_ENV = "LIVE_HARNESS_SCREENSHOTS";
export const LIVE_HARNESS_ARTIFACT_ROOT_ENV = "LIVE_HARNESS_ARTIFACT_ROOT";
export const LIVE_HARNESS_RETENTION_DAYS = 14;
export const LIVE_HARNESS_RESULTS_FILE = "results.jsonl";

const RUN_ID_PATTERN = /^(\d{8}T\d{6}Z)-[a-f0-9]{8}$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DAY_MS = 24 * 60 * 60 * 1000;

export type LiveHarnessArtifactOptions = {
  root: string;
  screenshots: boolean;
};

export type LiveHarnessResultRow = {
  schemaVersion: "live-harness-run-artifacts.v1";
  runId: string;
  provider: string;
  requestedQuantity: number;
  providerQuoteId: string | null;
  quoteUrl: string | null;
  timestamp: string;
  status: string | null;
  errorCode: string | null;
  totalPriceUsd: number | null;
  /**
   * OVD-785: adapter-normalized lead time for the first offer. Optional so
   * rows written before this field existed still parse as v1.
   */
  leadTimeBusinessDays?: number | null;
  artifacts: Array<{ kind: VendorArtifact["kind"]; label: string; path: string }>;
};

export type LiveHarnessRunArtifacts = {
  runId: string;
  root: string;
  runDir: string;
  screenshotHook(provider: string, quantity: number): HarnessPriceCaptureHook | undefined;
  recordResult(input: {
    provider: string;
    requestedQuantity: number;
    quoteUrl: string | null;
    status: string | null;
    errorCode: string | null;
    totalPriceUsd: number | null;
    leadTimeBusinessDays?: number | null;
    artifacts: readonly VendorArtifact[];
    now?: Date;
  }): Promise<LiveHarnessResultRow>;
};

/** Screenshots require the exact opt-in value; anything else leaves them off. */
export function liveHarnessArtifactOptions(
  env: NodeJS.ProcessEnv = process.env,
): LiveHarnessArtifactOptions {
  const root = env[LIVE_HARNESS_ARTIFACT_ROOT_ENV]?.trim()
    || path.join(os.homedir(), "overnight", "artifacts");
  return { root: path.resolve(root), screenshots: env[LIVE_HARNESS_SCREENSHOTS_ENV] === "1" };
}

export function createLiveHarnessRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(/[-:]/g, "");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function runIdTime(runId: string): number | null {
  const stamp = RUN_ID_PATTERN.exec(runId)?.[1];
  if (!stamp) return null;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

/** Keeps only scheme, host and path: query strings, fragments and userinfo are dropped. */
export function stripQuoteUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

/** Reads the provider quote id from the quote page path, for example /quoting/quote/Q12-3456-7890. */
export function parseProviderQuoteId(rawUrl: string | null): string | null {
  const stripped = stripQuoteUrl(rawUrl);
  if (!stripped) return null;
  return /\/quote\/(Q\d{2}-\d{4}-\d{4})(?:\/|$)/.exec(new URL(stripped).pathname)?.[1] ?? null;
}

/** Only a whole, non-negative business-day count is recorded; anything else is null. */
function leadTimeOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function assertOutsideRepository(root: string) {
  const relative = path.relative(REPO_ROOT, root);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Live harness artifact root must be outside the repository.");
  }
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return value.slice(start, end);
}

function safeSegment(value: string): string {
  return trimDashes(value.replaceAll(/[^a-z0-9-]+/gi, "-")).slice(0, 60) || "artifact";
}

/**
 * Deletes run directories older than the retention window. Only directories
 * whose names are harness run ids are considered; anything else is left alone.
 */
export async function cleanupExpiredLiveHarnessRuns(options: {
  root: string;
  now?: Date;
  retentionDays?: number;
  dryRun?: boolean;
}): Promise<{ deleted: string[]; kept: string[] }> {
  const cutoff = (options.now ?? new Date()).getTime()
    - (options.retentionDays ?? LIVE_HARNESS_RETENTION_DAYS) * DAY_MS;
  const entries = await fs.readdir(options.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const deleted: string[] = [];
  const kept: string[] = [];
  for (const entry of entries) {
    const time = entry.isDirectory() ? runIdTime(entry.name) : null;
    if (time === null) continue;
    if (time >= cutoff) kept.push(entry.name);
    else deleted.push(entry.name);
  }
  if (!options.dryRun) {
    await Promise.all(deleted.map((runId) =>
      fs.rm(path.join(options.root, runId), { recursive: true, force: true })));
  }
  const byRunId = (a: string, b: string) => a.localeCompare(b);
  deleted.sort(byRunId);
  kept.sort(byRunId);
  return { deleted, kept };
}

/** Applies retention, then creates this run's 0700 directory under the artifact root. */
export async function openLiveHarnessRunArtifacts(
  options: LiveHarnessArtifactOptions & { now?: Date },
): Promise<LiveHarnessRunArtifacts> {
  const root = path.resolve(options.root);
  assertOutsideRepository(root);
  await cleanupExpiredLiveHarnessRuns({ root, now: options.now });
  const runId = createLiveHarnessRunId(options.now);
  const runDir = path.join(root, runId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.mkdir(runDir, { mode: 0o700 });
  await fs.chmod(runDir, 0o700);
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const fileBase = (provider: string, quantity: number) =>
    `${runId}-${safeSegment(provider)}-q${quantity}`;

  return {
    runId,
    root,
    runDir,
    screenshotHook(provider, quantity) {
      if (!options.screenshots) return undefined;
      return async ({ page, label }) => {
        const localPath = path.join(runDir, `${fileBase(provider, quantity)}-${label}.png`);
        await page.screenshot({ path: localPath, fullPage: true, type: "png" });
        await fs.chmod(localPath, 0o600);
        return [{ kind: "screenshot", label: `${label}-screenshot`, localPath, contentType: "image/png" }];
      };
    },
    async recordResult(input) {
      const linkArtifact = async (
        artifact: (typeof input.artifacts)[number],
      ): Promise<LiveHarnessResultRow["artifacts"][number] | null> => {
        if (artifact.kind === "html_snapshot") {
          // Re-run the shared redactor on copy so only redacted DOM is linked.
          const html = await fs.readFile(artifact.localPath, "utf8").catch(() => null);
          if (html === null) return null;
          const target = path.join(
            runDir,
            `${fileBase(input.provider, input.requestedQuantity)}-${safeSegment(artifact.label)}.html`,
          );
          await fs.writeFile(target, redactProviderPortalHtml(html), { encoding: "utf8", mode: 0o600 });
          return { kind: artifact.kind, label: artifact.label, path: relative(target) };
        }
        if (artifact.kind === "screenshot" && path.dirname(path.resolve(artifact.localPath)) === runDir) {
          return { kind: artifact.kind, label: artifact.label, path: relative(artifact.localPath) };
        }
        return null;
      };
      // Promise.all keeps input order, so linked artifacts stay in adapter order.
      const linked = (await Promise.all(input.artifacts.map(linkArtifact)))
        .filter((artifact) => artifact !== null);
      const row: LiveHarnessResultRow = {
        schemaVersion: "live-harness-run-artifacts.v1",
        runId,
        provider: input.provider,
        requestedQuantity: input.requestedQuantity,
        providerQuoteId: parseProviderQuoteId(input.quoteUrl),
        quoteUrl: stripQuoteUrl(input.quoteUrl),
        timestamp: (input.now ?? new Date()).toISOString(),
        status: input.status,
        errorCode: input.errorCode,
        totalPriceUsd: input.totalPriceUsd,
        leadTimeBusinessDays: leadTimeOrNull(input.leadTimeBusinessDays),
        artifacts: linked,
      };
      await fs.appendFile(path.join(runDir, LIVE_HARNESS_RESULTS_FILE), `${JSON.stringify(row)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return row;
    },
  };
}
