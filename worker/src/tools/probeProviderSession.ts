import "dotenv/config";
import fs from "node:fs/promises";
import process from "node:process";
import { loadConfig } from "../config.js";
import {
  gcloudSecretLoader,
  parseProbeCliArgs,
  runSessionProbe,
  type SessionProbeEvidence,
} from "../providerSessionProbe.js";

async function main(): Promise<SessionProbeEvidence> {
  const args = parseProbeCliArgs(process.argv.slice(2));
  const config = loadConfig({
    ...process.env,
    // The probe never touches Supabase; schema-only placeholders keep the
    // production database credential out of this process.
    SUPABASE_URL: process.env.SUPABASE_URL ?? "https://probe.invalid",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "not-used-by-session-probe",
  });
  const project = args.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.CLOUDSDK_CORE_PROJECT;
  return runSessionProbe(args, {
    loadSecret: gcloudSecretLoader(project),
    sandbox: config,
    // TODO: no RMFG HTTP transport exists yet; see RMFG_PROBE_ENDPOINT.
  });
}

try {
  const outPath = (() => {
    const index = process.argv.indexOf("--out");
    return index >= 0 ? process.argv[index + 1] : undefined;
  })();
  const evidence = await main();
  const line = JSON.stringify(evidence);
  console.log(line);
  if (outPath) await fs.writeFile(outPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  process.exitCode = evidence.outcome === "authenticated" ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ outcome: "error", reason: error instanceof Error ? error.message : "unknown" }));
  process.exit(1);
}
