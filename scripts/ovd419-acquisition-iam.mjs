import { createHash } from "node:crypto";
import { ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { compareCodeUnits, TARGET } from "./ovd419-job-diagnostic.mjs";
import { OVD410_PRODUCTION_CONTRACT } from "./xometry-stable-egress-contract.mjs";

const REQUIRED_PERMISSIONS = Object.freeze(["run.executions.list", "run.jobs.get"]);
const MEMBER = `serviceAccount:${OVD410_PRODUCTION_CONTRACT.serviceAccount}`;
const reject = () => { throw new Error("acquisition_iam_rejected"); };
function requireValue(value) { if (!value) reject(); }
function object(value) {
  requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
}
function shape(value, required, optional = []) {
  object(value);
  const keys = Object.keys(value);
  requireValue(required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key)));
}
function boundedText(value, maximum) {
  requireValue(typeof value === "string" && value.length > 0
    && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value));
}
function body(raw) {
  requireValue(typeof raw === "string");
  const bytes = Buffer.byteLength(raw);
  requireValue(bytes <= ACQUISITION_LIMITS.cloudResponseBytes);
  return { bytes, value: parseBoundedSqlJson(raw, ACQUISITION_LIMITS.cloudResponseBytes) };
}
function selectedRole(value) {
  const global = /^roles\/[A-Za-z0-9_.-]{1,249}$/.test(value);
  const local = new RegExp(`^projects\/${TARGET.project}\/roles\/[A-Za-z0-9_.-]{1,200}$`).test(value);
  requireValue(global || local);
  return local;
}
function command(role, local) {
  const describedRole = local ? role.slice(role.lastIndexOf("/") + 1) : role;
  const args = ["iam", "roles", "describe", describedRole, "--format=json(includedPermissions)"];
  if (local) args.push("--project", TARGET.project);
  return Object.freeze(args);
}

function rolesFromPolicy(value) {
  shape(value, ["bindings"], ["etag", "version"]);
  if (value.etag !== undefined) requireValue(typeof value.etag === "string" && /^[A-Za-z0-9+/_=-]{1,256}$/.test(value.etag));
  if (value.version !== undefined) requireValue(value.version === 1 || value.version === 3);
  requireValue(Array.isArray(value.bindings));
  const roles = new Map();
  for (const binding of value.bindings) {
    shape(binding, ["role", "members"], ["condition"]);
    boundedText(binding.role, 256); requireValue(Array.isArray(binding.members));
    const members = new Set();
    for (const member of binding.members) {
      boundedText(member, 512); requireValue(!members.has(member)); members.add(member);
      requireValue(member !== "allUsers" && member !== "allAuthenticatedUsers");
    }
    if (!members.has(MEMBER)) continue;
    requireValue(binding.condition === undefined && !roles.has(binding.role));
    const local = selectedRole(binding.role);
    roles.set(binding.role, { role: binding.role, args: command(binding.role, local) });
    requireValue(roles.size <= ACQUISITION_LIMITS.maximumMatchingRoleBindings);
  }
  requireValue(roles.size > 0);
  return roles;
}

function selection(policyRaw, options) {
  shape(options, ["mode"]); requireValue(options.mode === "TEST_ONLY");
  const policy = body(policyRaw), selected = rolesFromPolicy(policy.value);
  const roles = Object.freeze([...selected.values()].sort((left, right) => compareCodeUnits(left.role, right.role))
    .map(({ role, args }) => Object.freeze({ role, args })));
  return { policy, selected, roles };
}

function roleEvidence(roleResponses, selected, policyBytes) {
  requireValue(Array.isArray(roleResponses) && roleResponses.length === selected.size);
  const evidence = new Map(), permissions = new Set();
  let receivedBytes = policyBytes;
  for (const response of roleResponses) {
    shape(response, ["role", "raw"]); boundedText(response.role, 256);
    requireValue(selected.has(response.role) && !evidence.has(response.role));
    requireValue(typeof response.raw === "string");
    const responseBytes = Buffer.byteLength(response.raw);
    requireValue(responseBytes <= ACQUISITION_LIMITS.cloudResponseBytes);
    receivedBytes += responseBytes;
    requireValue(receivedBytes <= ACQUISITION_LIMITS.aggregateTransportBytes);
    const value = parseBoundedSqlJson(response.raw, ACQUISITION_LIMITS.cloudResponseBytes);
    shape(value, ["includedPermissions"]); requireValue(Array.isArray(value.includedPermissions));
    const local = new Set();
    for (const permission of value.includedPermissions) {
      requireValue(typeof permission === "string" && /^[a-z][A-Za-z0-9_.-]{0,255}$/.test(permission));
      requireValue(!local.has(permission)); local.add(permission); permissions.add(permission);
    }
    evidence.set(response.role, { raw: response.raw,
      sha256: createHash("sha256").update(response.raw).digest("hex") });
  }
  requireValue(evidence.size === selected.size
    && REQUIRED_PERMISSIONS.every(permission => permissions.has(permission)));
  return { evidence, permissions, receivedBytes };
}

/**
 * Interpret the fixed runtime service account's project IAM role evidence. This
 * function performs no discovery or I/O. B3 must prove request attribution,
 * sequencing, freshness, deadlines, and actual received-byte accounting.
 */
export function validateSyntheticRuntimeIamEvidence(policyRaw, roleResponses, options) {
  try {
    const { policy, selected } = selection(policyRaw, options);
    const { evidence, permissions, receivedBytes } = roleEvidence(roleResponses, selected, policy.bytes);
    const roles = Object.freeze([...selected.values()].sort((left, right) => compareCodeUnits(left.role, right.role))
      .map(({ role, args }) => Object.freeze({ role, args, raw: evidence.get(role).raw, sha256: evidence.get(role).sha256 })));
    return Object.freeze({
      schema: "OVD419-SYNTHETIC-IAM-NOT-AUTHORITY-v1",
      policy: Object.freeze({ raw: policyRaw, sha256: createHash("sha256").update(policyRaw).digest("hex") }),
      roles, permissions: Object.freeze([...permissions].sort(compareCodeUnits)), receivedBytes,
      transportQualified: false, fullAcquisitionQualified: false, privateBindingReady: false,
    });
  } catch { reject(); }
}

/**
 * Select the exact serial role-describe requests required by synthetic E05.
 * Parsing and role bounds are shared with the final IAM evidence validator.
 */
export function selectSyntheticRuntimeIamRoleRequests(policyRaw, options) {
  try { return selection(policyRaw, options).roles; } catch { reject(); }
}
