import "dotenv/config";
import fs from "node:fs/promises";
import process from "node:process";
import { chromium, type BrowserContext } from "playwright";
import {
  acquireXometryProfileLock,
  withXometryProfileInterprocessLock,
} from "../adapters/persistentProfileLock.js";
import { loadCamoufoxLaunchIdentity } from "../camoufoxProfileIdentity.js";
import { launchPersistentCamoufox } from "../camoufoxPersistentContext.js";
import { loadConfig } from "../config.js";
import {
  restoreXometryProfileSnapshot,
  withXometryProfileSnapshotLock,
} from "../xometryProfileSnapshot.js";
import {
  buildXometryAuthProbeFailureEvidence,
  buildXometryAuthProbeEvidenceFromBounded,
  isSupportedXometryAuthProbeEngine,
  runBoundedXometryAuthProbe,
  withClosingXometryAuthProbeContext,
  XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
  XOMETRY_AUTH_PROBE_PLAYWRIGHT_CONTEXT_GUARDS,
} from "../xometryAuthProbe.js";

async function main() {
  const config = loadConfig({
    ...process.env,
    // The probe does not access Supabase. These schema-only placeholders keep
    // the Cloud Run job free of the production database credential.
    SUPABASE_URL: process.env.SUPABASE_URL ?? "https://probe.invalid",
    SUPABASE_SERVICE_ROLE_KEY:
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "not-used-by-auth-probe",
  });
  if (!isSupportedXometryAuthProbeEngine(config.xometryBrowserEngine)) {
    throw new Error(
      "The production authentication probe requires XOMETRY_BROWSER_ENGINE=playwright or camoufox.",
    );
  }
  if (
    !config.xometryProfileSnapshotBucket ||
    !config.xometryProfileSnapshotObject
  ) {
    throw new Error(
      "The production authentication probe requires snapshot mode.",
    );
  }

  if (!config.xometryUserDataDir) {
    throw new Error(
      "Snapshot mode did not resolve a local Xometry profile directory.",
    );
  }
  const evidence = await withXometryProfileInterprocessLock(
    config.xometryUserDataDir,
    { waitMs: config.xometryProfileLockWaitMs, vendor: "xometry-auth-probe" },
    () =>
      withXometryProfileSnapshotLock(async () => {
        const restored = await restoreXometryProfileSnapshot(config);
        if (
          !restored.xometryUserDataDir ||
          !restored.xometryProfileSnapshotGeneration
        ) {
          throw new Error(
            "The profile snapshot was not restored with generation ownership.",
          );
        }
        if (!isSupportedXometryAuthProbeEngine(restored.xometryBrowserEngine)) {
          throw new Error(
            "The restored profile uses an unsupported authentication probe engine.",
          );
        }
        const snapshotGeneration =
          restored.xometryProfileSnapshotGeneration;
        const browserEngine = restored.xometryBrowserEngine;

        await fs.mkdir(restored.xometryUserDataDir, { recursive: true });
        let context: BrowserContext;
        if (restored.xometryBrowserEngine === "camoufox") {
          const identity = await loadCamoufoxLaunchIdentity(
            restored.xometryUserDataDir,
            {
              required: true,
            },
          );
          ({ context } = await launchPersistentCamoufox({
            userDataDir: restored.xometryUserDataDir,
            headless: restored.playwrightHeadless,
            identityConfig: identity.config,
            launchOverrides: XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
          }));
        } else {
          await acquireXometryProfileLock(restored.xometryUserDataDir, {
            waitMs: restored.xometryProfileLockWaitMs,
            vendor: "xometry-auth-probe",
          });

          const launchArgs: string[] = [];
          if (restored.playwrightDisableSandbox) {
            launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
          }
          if (restored.playwrightDisableDevShmUsage) {
            launchArgs.push("--disable-dev-shm-usage");
          }

          context = await chromium.launchPersistentContext(
            restored.xometryUserDataDir,
            {
              headless: restored.playwrightHeadless,
              args: launchArgs,
              channel: restored.xometryBrowserChannel ?? undefined,
              ...XOMETRY_AUTH_PROBE_PLAYWRIGHT_CONTEXT_GUARDS,
            },
          );
        }
        context.setDefaultTimeout(restored.browserTimeoutMs);
        context.setDefaultNavigationTimeout(restored.browserTimeoutMs);
        return withClosingXometryAuthProbeContext(
          context,
          async () => {
            const boundedEvidence = await runBoundedXometryAuthProbe(context);
            return buildXometryAuthProbeEvidenceFromBounded({
              evidence: boundedEvidence,
              snapshotGeneration,
              browserEngine,
            });
          },
          { operationTimeoutMs: restored.browserTimeoutMs * 2 },
        );
      }),
  );

  return evidence;
}

try {
  const evidence = await main();
  console.log(JSON.stringify(evidence));
  if (!evidence.authenticated) process.exitCode = 1;
} catch {
  console.error(JSON.stringify(buildXometryAuthProbeFailureEvidence()));
  process.exit(1);
}
