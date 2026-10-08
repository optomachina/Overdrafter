import { pathToFileURL } from "node:url";
import { createCapabilityCanaryRuntime, REVIEWED_CANARY_PROBES, type CanaryRuntimeResult } from "../providerCapabilityCanaryRuntime.js";

/** The executable intentionally has no installed provider/session/service binding. */
export async function runCapabilityCanaryTool(
  env: Record<string, string | undefined>,
  argv: string[],
  execute = createCapabilityCanaryRuntime({ bindings: REVIEWED_CANARY_PROBES, now: Date.now }),
): Promise<CanaryRuntimeResult> {
  if (env.CANARY_SCHEDULE_ENABLED !== "true" || env.CANARY_TRIGGER_ENABLED !== "true") return { state: "disabled" };
  if (argv.length !== 0 || !env.CANARY_REQUEST_JSON || Buffer.byteLength(env.CANARY_REQUEST_JSON) > 65536) return { state: "invalid_configuration" };
  try { return await execute(JSON.parse(env.CANARY_REQUEST_JSON)); }
  catch { return { state: "invalid_configuration" }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCapabilityCanaryTool(process.env, process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.state === "disabled" || result.state === "recorded" ? 0 : 2;
  });
}
