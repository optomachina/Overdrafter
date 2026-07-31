import {
  loadMobileAuthConfig,
  type MobileAuthServerConfig,
} from "./config.js";
import { containsAsciiControlCharacters } from "./contract.js";

export type MobileAuthEnvironment = "test" | "local" | "preview" | "production";

export interface MobileAuthRuntimeConfig extends MobileAuthServerConfig {
  readonly environment: MobileAuthEnvironment;
  readonly cronSecret: string;
}

const ENVIRONMENTS = new Set<MobileAuthEnvironment>([
  "test",
  "local",
  "preview",
  "production",
]);

function readRuntimeValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximumLength: number,
): string {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    containsAsciiControlCharacters(value)
  ) {
    throw new Error("Mobile authentication runtime configuration is invalid.");
  }

  return value;
}

/**
 * Loads the complete runtime configuration, including the environment label
 * and the secret required by the authenticated cleanup route.
 */
export function loadMobileAuthRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): MobileAuthRuntimeConfig {
  const environmentName = readRuntimeValue(
    environment,
    "MOBILE_AUTH_ENVIRONMENT",
    16,
  );
  if (!ENVIRONMENTS.has(environmentName as MobileAuthEnvironment)) {
    throw new Error("Mobile authentication runtime configuration is invalid.");
  }

  const runtimeEnvironment = environmentName as MobileAuthEnvironment;
  const allowInsecureLocalhost =
    environment.MOBILE_AUTH_ALLOW_INSECURE_LOCALHOST === "1" &&
    (runtimeEnvironment === "test" || runtimeEnvironment === "local");
  const serverConfig = loadMobileAuthConfig(environment, {
    allowInsecureLocalhostForTests: allowInsecureLocalhost,
  });
  const cronSecret = readRuntimeValue(environment, "CRON_SECRET", 512);
  if (cronSecret.length < 32) {
    throw new Error("Mobile authentication runtime configuration is invalid.");
  }

  return Object.freeze({
    ...serverConfig,
    environment: runtimeEnvironment,
    cronSecret,
  });
}
