import { createHash } from "node:crypto";

/**
 * Provider-free policy and runtime-evidence boundary for OVD-420 recovery
 * egress. This module deliberately has no filesystem, process, or network
 * effects so both recovery commands can bind to the same reviewed policy.
 */
export const OVD420_RECOVERY_EGRESS_CONTRACT = Object.freeze({
  contractId: "ovd420-recovery-egress-v1",
  policyVersion: 1,
  maxHostnames: 32,
  evidenceSchema: "ovd420-recovery-egress-evidence-v1",
  network: "ovd420-recovery-egress",
  subnet: "172.28.42.0/29", // NOSONAR — immutable private recovery-only Docker topology.
  gateway: "172.28.42.1", // NOSONAR — host gateway inside that isolated topology.
  bridge: "ovd420-egress0",
  dnsService: "ovd420-dns",
  gatewayService: "ovd420-haproxy",
  browserService: "ovd420-browser",
  dnsTcpPort: 53,
  dnsUdpPort: 53,
  tlsPort: 443,
});

export const OVD420_FAILURE_CODES = Object.freeze([
  "invalid_policy",
  "invalid_evidence",
  "contract_id_mismatch",
  "evidence_schema_mismatch",
  "policy_digest_mismatch",
  "hostname_set_mismatch",
  "topology_mismatch",
  "service_health_invalid",
  "listener_mismatch",
  "firewall_not_default_deny",
  "policy_identity_mismatch",
]);

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_PATTERN = /^[0-9a-f:]+$/i;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isByteArray(value) {
  return (
    ArrayBuffer.isView(value) &&
    value.BYTES_PER_ELEMENT === 1 &&
    typeof value.length === "number"
  );
}

function hasOnlyKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function utf8PolicyInput(input) {
  if (typeof input === "string") return input;
  if (isByteArray(input)) {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  }
  throw new TypeError("Recovery egress policy must be UTF-8 bytes or a string.");
}

/** Normalize one approved DNS hostname without accepting IPs, wildcards, or Unicode. */
export function normalizeRecoveryEgressHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) {
    throw new TypeError("Recovery egress hostname must be a non-empty string.");
  }
  if (!/^[\x00-\x7f]+$/.test(hostname)) {
    throw new TypeError("Recovery egress hostname must be ASCII.");
  }
  const normalized = hostname.toLowerCase();
  if (
    normalized.includes("*") ||
    normalized.includes("/") ||
    normalized.endsWith(".") ||
    IPV4_PATTERN.test(normalized) ||
    IPV6_PATTERN.test(normalized) ||
    normalized.split(".").some((label) => label.startsWith("xn--")) ||
    !HOSTNAME_PATTERN.test(normalized)
  ) {
    throw new TypeError("Recovery egress hostname is malformed.");
  }
  return normalized;
}

/**
 * Parse the only supported policy shape and return its canonical form. Input
 * ordering and ASCII case do not affect the policy digest; duplicate names do.
 */
export function parseRecoveryEgressPolicy(input) {
  const source = utf8PolicyInput(input);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError("Recovery egress policy is not valid JSON.");
  }
  if (!hasOnlyKeys(value, ["version", "hostnames"])) {
    throw new TypeError("Recovery egress policy has an invalid shape.");
  }
  if (value.version !== OVD420_RECOVERY_EGRESS_CONTRACT.policyVersion) {
    throw new TypeError("Recovery egress policy version is unsupported.");
  }
  if (
    !Array.isArray(value.hostnames) ||
    value.hostnames.length === 0 ||
    value.hostnames.length > OVD420_RECOVERY_EGRESS_CONTRACT.maxHostnames
  ) {
    throw new TypeError("Recovery egress policy requires approved hostnames.");
  }
  const hostnames = value.hostnames.map(normalizeRecoveryEgressHostname).sort();
  if (new Set(hostnames).size !== hostnames.length) {
    throw new TypeError("Recovery egress policy contains duplicate hostnames.");
  }
  const canonical = JSON.stringify({ version: value.version, hostnames });
  return Object.freeze({
    version: value.version,
    hostnames: Object.freeze(hostnames),
    canonical,
    digest: sha256Hex(canonical),
  });
}

/** SHA-256 digest used to bind both recovery paths to the canonical policy. */
export function sha256Hex(value) {
  if (typeof value !== "string" && !isByteArray(value)) {
    throw new TypeError("SHA-256 input must be a string or bytes.");
  }
  return createHash("sha256").update(value).digest("hex");
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function policyBindingMatches(value, policy) {
  return (
    hasOnlyKeys(value, ["contractId", "digest"]) &&
    value.contractId === OVD420_RECOVERY_EGRESS_CONTRACT.contractId &&
    value.digest === policy.digest
  );
}

function listenerMatches(value, protocol, port) {
  return (
    hasOnlyKeys(value, ["host", "protocol", "port"]) &&
    value.host === OVD420_RECOVERY_EGRESS_CONTRACT.gateway &&
    value.protocol === protocol &&
    value.port === port
  );
}

function validPolicy(policy) {
  if (
    !isRecord(policy) ||
    typeof policy.digest !== "string" ||
    !Array.isArray(policy.hostnames) ||
    typeof policy.canonical !== "string"
  ) {
    return false;
  }
  try {
    const parsed = parseRecoveryEgressPolicy(policy.canonical);
    return (
      parsed.digest === policy.digest &&
      parsed.version === policy.version &&
      sameStrings(parsed.hostnames, policy.hostnames)
    );
  } catch {
    return false;
  }
}

/**
 * Evaluate sanitized runtime evidence. It never throws and returns only fixed
 * reason codes, so callers can fail closed without logging policy contents.
 */
export function evaluateRecoveryEgressRuntimeEvidence(evidence, policy) {
  const failures = [];
  const fail = (code) => {
    if (!failures.includes(code)) failures.push(code);
  };
  if (!validPolicy(policy)) {
    fail("invalid_policy");
    return Object.freeze({ ok: false, failures: Object.freeze(failures) });
  }
  const keys = [
    "schema",
    "contractId",
    "policyDigest",
    "hostnames",
    "topology",
    "services",
    "listeners",
    "firewall",
    "policyIdentities",
  ];
  if (!hasOnlyKeys(evidence, keys)) {
    fail("invalid_evidence");
    return Object.freeze({ ok: false, failures: Object.freeze(failures) });
  }
  if (evidence.schema !== OVD420_RECOVERY_EGRESS_CONTRACT.evidenceSchema) fail("evidence_schema_mismatch");
  if (evidence.contractId !== OVD420_RECOVERY_EGRESS_CONTRACT.contractId) fail("contract_id_mismatch");
  if (evidence.policyDigest !== policy.digest) fail("policy_digest_mismatch");
  if (!sameStrings(evidence.hostnames, policy.hostnames)) fail("hostname_set_mismatch");
  const topology = OVD420_RECOVERY_EGRESS_CONTRACT;
  if (
    !hasOnlyKeys(evidence.topology, ["network", "subnet", "gateway", "bridge"]) ||
    evidence.topology.network !== topology.network ||
    evidence.topology.subnet !== topology.subnet ||
    evidence.topology.gateway !== topology.gateway ||
    evidence.topology.bridge !== topology.bridge
  ) fail("topology_mismatch");
  if (
    !hasOnlyKeys(evidence.services, ["dns", "gateway", "browser"]) ||
    evidence.services.dns !== "healthy" ||
    evidence.services.gateway !== "healthy" ||
    evidence.services.browser !== "absent"
  ) fail("service_health_invalid");
  if (
    !hasOnlyKeys(evidence.listeners, ["dnsTcp", "dnsUdp", "tls"]) ||
    !listenerMatches(evidence.listeners.dnsTcp, "tcp", topology.dnsTcpPort) ||
    !listenerMatches(evidence.listeners.dnsUdp, "udp", topology.dnsUdpPort) ||
    !listenerMatches(evidence.listeners.tls, "tcp", topology.tlsPort)
  ) fail("listener_mismatch");
  if (
    !hasOnlyKeys(evidence.firewall, ["dockerUserDefaultDeny", "browserNetworkRestricted"]) ||
    evidence.firewall.dockerUserDefaultDeny !== true ||
    evidence.firewall.browserNetworkRestricted !== true
  ) fail("firewall_not_default_deny");
  if (
    !hasOnlyKeys(evidence.policyIdentities, ["classifier", "fullRecovery"]) ||
    !policyBindingMatches(evidence.policyIdentities.classifier, policy) ||
    !policyBindingMatches(evidence.policyIdentities.fullRecovery, policy)
  ) fail("policy_identity_mismatch");
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}
