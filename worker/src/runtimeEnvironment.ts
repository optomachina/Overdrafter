import type { WorkerConfig } from "./types.js";

const PRODUCTION_ENV_VALUES = new Set(["prod", "production"]);

function normalizeEnvValue(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const nodeEnv = normalizeEnvValue(env.NODE_ENV);
  const vercelEnv = normalizeEnvValue(env.VERCEL_ENV);
  const appEnv = normalizeEnvValue(env.APP_ENV);

  return (
    PRODUCTION_ENV_VALUES.has(nodeEnv) ||
    PRODUCTION_ENV_VALUES.has(vercelEnv) ||
    PRODUCTION_ENV_VALUES.has(appEnv)
  );
}

export function shouldWarnSimulateModeInProduction(
  config: Pick<WorkerConfig, "workerMode">,
  env: NodeJS.ProcessEnv = process.env,
) {
  return config.workerMode === "simulate" && isProductionEnvironment(env);
}
