import { describe, expect, it } from "vitest";
import {
  OVD420_RECOVERY_EGRESS_CONTRACT as CONTRACT,
  evaluateRecoveryEgressRuntimeEvidence,
  normalizeRecoveryEgressHostname,
  parseRecoveryEgressPolicy,
  sha256Hex,
} from "./ovd420-recovery-egress-contract.mjs";

const RAW_POLICY = JSON.stringify({
  version: 1,
  hostnames: ["API.XOMETRY.COM", "www.xometry.com"],
});

function healthyEvidence(policy) {
  const identity = { contractId: CONTRACT.contractId, digest: policy.digest };
  const endpoint = (protocol, port) => ({ host: CONTRACT.gateway, protocol, port });
  return {
    schema: CONTRACT.evidenceSchema,
    contractId: CONTRACT.contractId,
    policyDigest: policy.digest,
    hostnames: [...policy.hostnames],
    topology: {
      network: CONTRACT.network,
      subnet: CONTRACT.subnet,
      gateway: CONTRACT.gateway,
      bridge: CONTRACT.bridge,
    },
    services: { dns: "healthy", gateway: "healthy", browser: "absent" },
    listeners: {
      dnsTcp: endpoint("tcp", CONTRACT.dnsTcpPort),
      dnsUdp: endpoint("udp", CONTRACT.dnsUdpPort),
      tls: endpoint("tcp", CONTRACT.tlsPort),
    },
    firewall: { dockerUserDefaultDeny: true, browserNetworkRestricted: true },
    policyIdentities: { classifier: { ...identity }, fullRecovery: { ...identity } },
  };
}

describe("OVD-420 recovery egress policy contract", () => {
  it("canonicalizes ASCII case and binds the sorted hostname set by SHA-256", () => {
    const policy = parseRecoveryEgressPolicy(new TextEncoder().encode(RAW_POLICY));

    expect(policy.hostnames).toEqual(["api.xometry.com", "www.xometry.com"]);
    expect(policy.canonical).toBe('{"version":1,"hostnames":["api.xometry.com","www.xometry.com"]}');
    expect(policy.digest).toBe(sha256Hex(policy.canonical));
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([
    ["unsupported policy version", '{"version":2,"hostnames":["api.xometry.com"]}'],
    ["empty hostnames", '{"version":1,"hostnames":[]}'],
    ["unknown field", '{"version":1,"hostnames":["api.xometry.com"],"mode":"open"}'],
    ["duplicate normalized hostname", '{"version":1,"hostnames":["API.XOMETRY.COM","api.xometry.com"]}'],
    ["wildcard", '{"version":1,"hostnames":["*.xometry.com"]}'],
    ["IPv4 address", '{"version":1,"hostnames":["192.0.2.1"]}'],
    ["IPv6 address", '{"version":1,"hostnames":["2001:db8::1"]}'],
    ["Unicode hostname", '{"version":1,"hostnames":["éxample.com"]}'],
    ["punycode hostname", '{"version":1,"hostnames":["xn--xample-9ua.com"]}'],
    ["malformed hostname", '{"version":1,"hostnames":["api..xometry.com"]}'],
    [
      "hostname count above the bounded policy limit",
      JSON.stringify({
        version: 1,
        hostnames: Array.from(
          { length: CONTRACT.maxHostnames + 1 },
          (_, index) => `host-${index}.example.com`,
        ),
      }),
    ],
  ])("rejects %s", (_label, source) => {
    expect(() => parseRecoveryEgressPolicy(source)).toThrow(TypeError);
  });

  it("rejects malformed UTF-8 bytes", () => {
    expect(() => parseRecoveryEgressPolicy(new Uint8Array([0xc3, 0x28]))).toThrow(TypeError);
  });

  it("accepts complete evidence with matching policy identities", () => {
    const policy = parseRecoveryEgressPolicy(RAW_POLICY);
    expect(evaluateRecoveryEgressRuntimeEvidence(healthyEvidence(policy), policy)).toEqual({ ok: true, failures: [] });
  });

  it("fails closed with sanitized reasons for policy, topology, and firewall drift", () => {
    const policy = parseRecoveryEgressPolicy(RAW_POLICY);
    const evidence = healthyEvidence(policy);
    evidence.policyDigest = "a".repeat(64);
    evidence.hostnames = ["api.xometry.com"];
    evidence.topology.gateway = "172.28.42.254";
    evidence.firewall.dockerUserDefaultDeny = false;
    evidence.policyIdentities.fullRecovery.digest = "b".repeat(64);

    expect(evaluateRecoveryEgressRuntimeEvidence(evidence, policy)).toEqual({
      ok: false,
      failures: [
        "policy_digest_mismatch",
        "hostname_set_mismatch",
        "topology_mismatch",
        "firewall_not_default_deny",
        "policy_identity_mismatch",
      ],
    });
  });

  it("rejects a policy object whose hostname list does not match its canonical bytes", () => {
    const policy = parseRecoveryEgressPolicy(RAW_POLICY);
    const forgedPolicy = { ...policy, hostnames: ["api.xometry.com"] };

    expect(
      evaluateRecoveryEgressRuntimeEvidence(
        healthyEvidence(policy),
        forgedPolicy,
      ),
    ).toEqual({ ok: false, failures: ["invalid_policy"] });
  });

  it("rejects evidence scope expansion and unhealthy or misplaced services", () => {
    const policy = parseRecoveryEgressPolicy(RAW_POLICY);
    const expanded = healthyEvidence(policy);
    expanded.untrusted = true;
    expect(evaluateRecoveryEgressRuntimeEvidence(expanded, policy)).toEqual({
      ok: false,
      failures: ["invalid_evidence"],
    });

    const unhealthy = healthyEvidence(policy);
    unhealthy.services.gateway = "starting";
    unhealthy.listeners.tls.host = "0.0.0.0";
    expect(evaluateRecoveryEgressRuntimeEvidence(unhealthy, policy)).toEqual({
      ok: false,
      failures: ["service_health_invalid", "listener_mismatch"],
    });
  });
});
