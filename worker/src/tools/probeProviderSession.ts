import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  gcloudSecretLoader,
  parseProbeCliArgs,
  PROBE_USAGE,
  runSessionProbe,
  type SessionProbeEvidence,
} from "../providerSessionProbe.js";

// The probe needs only two Playwright sandbox booleans. It deliberately does
// not load the full worker config, so no database or provider settings are
// read into this process.
function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

// npm runs this from the worker folder; INIT_CWD is where the operator typed
// the command (the repository root), so relative paths resolve there.
function resolveFromInvocationDir(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), candidate);
}

let args;
try {
  args = parseProbeCliArgs(process.argv.slice(2));
} catch {
  console.error(JSON.stringify({ outcome: "error", reason: "invalid_arguments", usage: PROBE_USAGE }));
  process.exit(2);
}

try {
  const project = args.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.CLOUDSDK_CORE_PROJECT;
  const evidence: SessionProbeEvidence = await runSessionProbe(
    { ...args, storageStatePath: resolveFromInvocationDir(args.storageStatePath) },
    {
      loadSecret: gcloudSecretLoader(project),
      sandbox: {
        playwrightDisableSandbox: envFlag("PLAYWRIGHT_DISABLE_SANDBOX", false),
        playwrightDisableDevShmUsage: envFlag("PLAYWRIGHT_DISABLE_DEV_SHM_USAGE", true),
      },
      loopbackFixtureUrl: process.env.PROBE_TEST_LOOPBACK_URL,
      executablePath: process.env.PROBE_TEST_CHROMIUM_EXECUTABLE || undefined,
      // TODO: no RMFG HTTP transport exists yet; see RMFG_PROBE_ENDPOINT.
    },
  );
  const line = JSON.stringify(evidence);
  console.log(line);
  const outPath = resolveFromInvocationDir(args.outPath);
  if (outPath) await fs.writeFile(outPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  process.exitCode = evidence.outcome === "authenticated" ? 0 : 1;
} catch {
  // Fixed reason only: error text could carry secret or page content.
  console.error(JSON.stringify({ outcome: "error", reason: "probe_failed" }));
  process.exit(1);
}
