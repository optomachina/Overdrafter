import fs from "node:fs/promises";
import path from "node:path";

const CAMOUFOX_IDENTITY_SCHEMA = "overdrafter-camoufox-launch-identity.v1";
const CAMOUFOX_IDENTITY_FILE = ".overdrafter-camoufox-identity.json";
const CAMOUFOX_PENDING_IDENTITY_FILE =
  ".overdrafter-camoufox-identity.pending.json";
const CAMOUFOX_INVALID_IDENTITY_FILE =
  ".overdrafter-camoufox-identity.invalid";
const CAMOUFOX_IDENTITY_MAX_BYTES = 1_048_576;

export type CamoufoxLaunchIdentity = {
  schema: typeof CAMOUFOX_IDENTITY_SCHEMA;
  config: Record<string, unknown>;
};

function identityPath(userDataDir: string) {
  return path.join(userDataDir, CAMOUFOX_IDENTITY_FILE);
}

function pendingIdentityPath(userDataDir: string) {
  return path.join(userDataDir, CAMOUFOX_PENDING_IDENTITY_FILE);
}

function invalidIdentityPath(userDataDir: string) {
  return path.join(userDataDir, CAMOUFOX_INVALID_IDENTITY_FILE);
}

function validConfig(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0,
  );
}

/**
 * Invalidate export eligibility by atomically moving the private identity to
 * a recovery-only path. A failed or interrupted proof can reuse the exact
 * fingerprint, while normal worker and export loaders continue to fail closed.
 */
export async function invalidateCamoufoxLaunchIdentity(userDataDir: string) {
  await fs.writeFile(invalidIdentityPath(userDataDir), "invalid", {
    mode: 0o600,
  });
  try {
    await fs.rename(identityPath(userDataDir), pendingIdentityPath(userDataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function identityIsInvalidated(userDataDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(invalidIdentityPath(userDataDir));
    if (!stat.isFile()) {
      throw new Error("invalid identity interlock");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Camoufox profile launch identity is missing or invalid.");
  }
}

async function loadIdentityFile(
  filePath: string,
  optional = false,
): Promise<CamoufoxLaunchIdentity | null> {
  let raw: string;
  try {
    const stat = await fs.stat(filePath);
    if (
      !stat.isFile() ||
      stat.size <= 0 ||
      stat.size > CAMOUFOX_IDENTITY_MAX_BYTES
    ) {
      throw new Error("invalid identity file");
    }
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) {
      return null;
    }
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
  if (await identityIsInvalidated(userDataDir)) {
    if (!options.required) return null;
    throw new Error("Camoufox profile launch identity is missing or invalid.");
  }
  return loadIdentityFile(identityPath(userDataDir), !options.required);
}

/** Load the verified identity or an invalidated recovery copy for another proof attempt. */
export async function loadCamoufoxLaunchIdentityForRecovery(
  userDataDir: string,
): Promise<CamoufoxLaunchIdentity | null> {
  const verified = await loadIdentityFile(identityPath(userDataDir), true);
  if (verified) return verified;
  return loadIdentityFile(pendingIdentityPath(userDataDir), true);
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
    await fs.rm(pendingIdentityPath(userDataDir), { force: true });
    await fs.rm(invalidIdentityPath(userDataDir), { force: true });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
