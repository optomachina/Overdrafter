import {
  MOBILE_AUTH_LIMITS,
  MOBILE_AUTH_PATHS,
  containsAsciiControlCharacters,
  type MobileAuthMasterKey,
  type MobileAuthMasterKeyring,
} from "./contract";
import { decodeCanonicalBase64Url } from "./crypto";

const MASTER_KEYRING_ENV = "MOBILE_AUTH_KEYRING";
const MASTER_KEY_CURRENT_VERSION_ENV = "MOBILE_AUTH_CURRENT_KEY_VERSION";
const KEY_VERSION_PATTERN = /^[1-9][0-9]{0,8}$/;
const LOCAL_TEST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface MobileAuthServerConfig {
  readonly appOrigin: string;
  readonly callbackUrl: string;
  readonly providerCallbackUrl: string;
  readonly supabaseOrigin: string;
  readonly supabasePublishableKey: string;
  readonly supabaseServiceRoleKey: string;
  readonly masterKeyring: MobileAuthMasterKeyring;
}

export interface LoadMobileAuthConfigOptions {
  readonly allowInsecureLocalhostForTests?: boolean;
}

export class MobileAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MobileAuthConfigError";
  }
}

function readRequiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximumLength = 8_192,
): string {
  const value = environment[name];

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    containsAsciiControlCharacters(value)
  ) {
    throw new MobileAuthConfigError(`${name} is missing or invalid.`);
  }

  return value;
}

function parseExactOrigin(
  value: string,
  name: string,
  options: LoadMobileAuthConfigOptions,
): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new MobileAuthConfigError(`${name} must be an absolute URL origin.`);
  }

  const permitsLocalHttp =
    options.allowInsecureLocalhostForTests === true &&
    parsed.protocol === "http:" &&
    LOCAL_TEST_HOSTS.has(parsed.hostname);

  if (
    (parsed.protocol !== "https:" && !permitsLocalHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    value !== parsed.origin
  ) {
    throw new MobileAuthConfigError(`${name} must be the exact configured HTTPS origin.`);
  }

  return parsed.origin;
}

function parseKeyVersion(value: string, name: string): number {
  if (!KEY_VERSION_PATTERN.test(value)) {
    throw new MobileAuthConfigError(`${name} must be a positive integer key version.`);
  }

  const version = Number(value);

  if (!Number.isSafeInteger(version)) {
    throw new MobileAuthConfigError(`${name} is outside the supported key-version range.`);
  }

  return version;
}

function parseMasterKeyring(
  environment: Readonly<Record<string, string | undefined>>,
): MobileAuthMasterKeyring {
  const currentVersion = parseKeyVersion(
    readRequiredEnvironmentValue(environment, MASTER_KEY_CURRENT_VERSION_ENV, 9),
    MASTER_KEY_CURRENT_VERSION_ENV,
  );
  const keys: MobileAuthMasterKey[] = [];
  const serializedKeyring = readRequiredEnvironmentValue(
    environment,
    MASTER_KEYRING_ENV,
    16_384,
  );
  let parsedKeyring: unknown;

  try {
    parsedKeyring = JSON.parse(serializedKeyring);
  } catch {
    throw new MobileAuthConfigError(`${MASTER_KEYRING_ENV} must be valid JSON.`);
  }

  if (
    typeof parsedKeyring !== "object" ||
    parsedKeyring === null ||
    Array.isArray(parsedKeyring)
  ) {
    throw new MobileAuthConfigError(`${MASTER_KEYRING_ENV} must be a JSON object.`);
  }

  for (const [versionText, encodedKey] of Object.entries(parsedKeyring)) {
    const version = parseKeyVersion(versionText, MASTER_KEYRING_ENV);
    let key: Uint8Array;

    try {
      if (typeof encodedKey !== "string" || encodedKey.length > 64) {
        throw new Error("invalid key");
      }
      key = decodeCanonicalBase64Url(encodedKey, 32);
    } catch {
      throw new MobileAuthConfigError(
        `${MASTER_KEYRING_ENV} values must be canonical base64url 32-byte keys.`,
      );
    }

    keys.push(Object.freeze({ version, key: Uint8Array.from(key) }));
  }

  keys.sort((left, right) => left.version - right.version);

  if (
    keys.length === 0 ||
    keys.length > MOBILE_AUTH_LIMITS.retainedKeyVersions ||
    !keys.some((candidate) => candidate.version === currentVersion)
  ) {
    throw new MobileAuthConfigError("The current mobile-auth master key is not configured.");
  }

  return Object.freeze({
    currentVersion,
    keys: Object.freeze(keys),
  });
}

export function loadMobileAuthConfig(
  environment: Readonly<Record<string, string | undefined>>,
  options: LoadMobileAuthConfigOptions = {},
): MobileAuthServerConfig {
  const appOrigin = parseExactOrigin(
    readRequiredEnvironmentValue(environment, "MOBILE_AUTH_APP_ORIGIN", 2_048),
    "MOBILE_AUTH_APP_ORIGIN",
    options,
  );
  const supabaseOrigin = parseExactOrigin(
    readRequiredEnvironmentValue(environment, "SUPABASE_URL", 2_048),
    "SUPABASE_URL",
    options,
  );
  const browserSupabaseOrigin = parseExactOrigin(
    readRequiredEnvironmentValue(environment, "VITE_SUPABASE_URL", 2_048),
    "VITE_SUPABASE_URL",
    options,
  );
  const supabasePublishableKey = readRequiredEnvironmentValue(
    environment,
    "SUPABASE_PUBLISHABLE_KEY",
  );
  const browserSupabasePublishableKey = readRequiredEnvironmentValue(
    environment,
    "VITE_SUPABASE_PUBLISHABLE_KEY",
  );
  const supabaseServiceRoleKey = readRequiredEnvironmentValue(
    environment,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  if (
    supabaseOrigin !== browserSupabaseOrigin ||
    supabasePublishableKey !== browserSupabasePublishableKey
  ) {
    throw new MobileAuthConfigError(
      "The server and browser Supabase configurations must identify the same project.",
    );
  }

  return Object.freeze({
    appOrigin,
    callbackUrl: new URL(MOBILE_AUTH_PATHS.callback, appOrigin).toString(),
    providerCallbackUrl: new URL(MOBILE_AUTH_PATHS.providerCallback, appOrigin).toString(),
    supabaseOrigin,
    supabasePublishableKey,
    supabaseServiceRoleKey,
    masterKeyring: parseMasterKeyring(environment),
  });
}

export function assertRequestMatchesConfiguredOrigin(
  requestUrl: string | URL,
  config: Pick<MobileAuthServerConfig, "appOrigin">,
): URL {
  let parsed: URL;

  try {
    parsed = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  } catch {
    throw new MobileAuthConfigError("The request URL is invalid.");
  }

  if (
    parsed.origin !== config.appOrigin ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new MobileAuthConfigError("The request origin does not match the configured origin.");
  }

  return parsed;
}
