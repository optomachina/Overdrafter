import fs from "node:fs/promises";
import path from "node:path";

const CAMOUFOX_IDENTITY_SCHEMA = "overdrafter-camoufox-launch-identity.v1";
const CAMOUFOX_IDENTITY_FILE = ".overdrafter-camoufox-identity.json";
const CAMOUFOX_IDENTITY_MAX_BYTES = 1_048_576;

export type CamoufoxLaunchIdentity = {
  schema: typeof CAMOUFOX_IDENTITY_SCHEMA;
  config: Record<string, unknown>;
};

function identityPath(userDataDir: string) {
  return path.join(userDataDir, CAMOUFOX_IDENTITY_FILE);
}

function validConfig(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0,
  );
}

/** Load the private Camoufox launch identity bound to a persistent profile. */
export async function loadCamoufoxLaunchIdentity(
  userDataDir: string,
  options: { required: true },
): Promise<CamoufoxLaunchIdentity>;
export async function loadCamoufoxLaunchIdentity(
  userDataDir: string,
  options?: { required?: false },
): Promise<CamoufoxLaunchIdentity | null>;
export async function loadCamoufoxLaunchIdentity(
  userDataDir: string,
  options: { required?: boolean } = {},
): Promise<CamoufoxLaunchIdentity | null> {
  let raw: string;
  try {
    const stat = await fs.stat(identityPath(userDataDir));
    if (!stat.isFile() || stat.size <= 0 || stat.size > CAMOUFOX_IDENTITY_MAX_BYTES) {
      throw new Error("invalid identity file");
    }
    raw = await fs.readFile(identityPath(userDataDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !options.required) return null;
    throw new Error("Camoufox profile launch identity is missing or invalid.");
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CamoufoxLaunchIdentity>;
    if (parsed.schema !== CAMOUFOX_IDENTITY_SCHEMA || !validConfig(parsed.config)) {
      throw new Error("invalid identity payload");
    }
    return {
      schema: CAMOUFOX_IDENTITY_SCHEMA,
      config: parsed.config,
    };
  } catch {
    throw new Error("Camoufox profile launch identity is missing or invalid.");
  }
}

/** Persist a verified Camoufox launch identity inside its private profile. */
export async function saveCamoufoxLaunchIdentity(
  userDataDir: string,
  config: Record<string, unknown>,
) {
  if (!validConfig(config)) {
    throw new Error("Camoufox did not produce a launch identity.");
  }
  const target = identityPath(userDataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  const payload: CamoufoxLaunchIdentity = {
    schema: CAMOUFOX_IDENTITY_SCHEMA,
    config,
  };
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > CAMOUFOX_IDENTITY_MAX_BYTES) {
    throw new Error("Camoufox launch identity exceeds the safe size limit.");
  }
  try {
    await fs.writeFile(temporary, encoded, { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
