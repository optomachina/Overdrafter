import { createHash } from "node:crypto";
import { TARGET } from "./ovd419-job-diagnostic.mjs";
import { ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";

const reject = () => { throw new Error("acquisition_metadata_rejected"); };
function requireValue(value) { if (!value) reject(); }
function shape(value, fields) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Object.keys(value);
  requireValue(keys.length === fields.length && keys.every(key => fields.includes(key)));
}
function numericText(value, digits) {
  requireValue(typeof value === "string" && new RegExp(`^[1-9][0-9]{0,${digits - 1}}$`).test(value));
}
function metadata(raw, options, optionFields, kind, project) {
  try {
    shape(options, ["mode", ...optionFields]); requireValue(options.mode === "TEST_ONLY");
    // Reuse the duplicate-aware bounded JSON parser; these are raw JSON cloud
    // projections, not SQL wrappers or transport envelopes.
    const value = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.cloudResponseBytes);
    const projection = Object.freeze(project(value, options));
    return Object.freeze({ schema: "OVD419-SYNTHETIC-METADATA-NOT-AUTHORITY-v1", kind,
      raw, sha256: createHash("sha256").update(raw).digest("hex"), projection,
      transportQualified: false, privateBindingReady: false });
  } catch { reject(); }
}

/** Validate the pinned active-account projection; no account discovery or credential access. */
export function validateSyntheticPrincipal(raw, options) {
  return metadata(raw, options, [], "principal", value => {
    requireValue(Array.isArray(value) && value.length === 1);
    shape(value[0], ["account", "status"]);
    const { account, status } = value[0];
    requireValue(status === "ACTIVE" && typeof account === "string" && account.length > 0
      && Buffer.byteLength(account) <= 256 && !/[\s\u0000-\u001f\u007f]/.test(account));
    return { principal: account };
  });
}

/** Validate the retained snapshot metadata fields without numeric coercion or object access. */
export function validateSyntheticSnapshotMetadata(raw, options) {
  return metadata(raw, options, [], "snapshot", value => {
    shape(value, ["generation", "metageneration", "etag"]);
    numericText(value.generation, 20); numericText(value.metageneration, 20);
    requireValue(typeof value.etag === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value.etag));
    return { generation: value.generation, metageneration: value.metageneration, etag: value.etag };
  });
}

/**
 * Check global secret-version metadata against the fixed project/secret and a
 * caller-supplied project-number binding. The complete reader must establish that
 * binding from its attributable full Job; this pure TEST_ONLY check cannot prove
 * project-number ownership or transport authenticity. It never reads secret data.
 */
export function validateSyntheticSecretVersionMetadata(raw, options) {
  return metadata(raw, options, ["projectNumber", "referenceKey"], "secretVersion", (value, binding) => {
    numericText(binding.projectNumber, 20);
    if (binding.referenceKey !== "latest") numericText(binding.referenceKey, 19);
    shape(value, ["name", "state"]);
    requireValue(typeof value.name === "string" && value.state === "ENABLED");
    const parts = value.name.split("/");
    requireValue(parts.length === 6 && parts[0] === "projects" && parts[2] === "secrets"
      && parts[3] === "supabase-service-role-key" && parts[4] === "versions"
      && (parts[1] === TARGET.project || parts[1] === binding.projectNumber));
    const version = parts[5]; numericText(version, 19);
    requireValue(binding.referenceKey === "latest" || version === binding.referenceKey);
    return { secretVersion: version };
  });
}
