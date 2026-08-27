import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OVD420_RECOVERY_EGRESS_CONTRACT as CONTRACT,
  parseRecoveryEgressPolicy,
} from "./ovd420-recovery-egress-contract.mjs";

const SCRIPT = "scripts/ovd420-recovery-egress-control.sh";
const NETWORK_PROOF = "scripts/verify-ovd420-recovery-egress-network.sh";
const MAX_CNAME_DEPTH = 8;
const temporaryDirectories = [];

async function policyFile(value) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ovd420-policy-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "policy.json");
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), {
    mode: 0o600,
  });
  return file;
}

function runControl(...args) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runLaunchHarness(mode, credentialDirectory, record, verifyStatus = 0) {
  const image = `us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/worker@sha256:${"a".repeat(64)}`;
  const digest = "b".repeat(64);
  return spawnSync(
    "bash",
    [
      "-c",
      `source "$CONTROL_SCRIPT"
require_root() { :; }
credential_directory_for_mode() { printf '%s\\n' "$TEST_CREDENTIAL_DIR"; }
verify_control() {
  printf 'verify:%s\\n' "$1" >>"$TEST_RECORD"
  [[ "$TEST_VERIFY_STATUS" == '0' ]] || fail 'test_verification_failed'
}
docker() { printf 'docker:%s\\n' "$*" >>"$TEST_RECORD"; }
OVD420_RECOVERY_EGRESS_POLICY_SHA256="$TEST_DIGEST"
export OVD420_RECOVERY_EGRESS_POLICY_SHA256
launch_browser "$TEST_MODE" "$TEST_IMAGE" "$TEST_CREDENTIAL_DIR"`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CONTROL_SCRIPT: SCRIPT,
        TEST_CREDENTIAL_DIR: credentialDirectory,
        TEST_DIGEST: digest,
        TEST_IMAGE: image,
        TEST_MODE: mode,
        TEST_RECORD: record,
        TEST_VERIFY_STATUS: String(verifyStatus),
      },
    },
  );
}

function renderTestConfig(policy, addressMap, dnsConfig, haproxyConfig) {
  return spawnSync("bash", [SCRIPT, "test-render", policy, addressMap, dnsConfig, haproxyConfig], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, OVD420_RECOVERY_EGRESS_TEST_RENDER: "1" },
  });
}

async function resolveFixture(policy, answer) {
  const directory = path.dirname(policy);
  const binDirectory = path.join(directory, "bin");
  const addressMap = path.join(directory, "addresses.json");
  await mkdir(binDirectory);
  await writeFile(
    path.join(binDirectory, "dig"),
    "#!/usr/bin/env bash\nprintf '%s' \"$TEST_DNS_ANSWER\"\n",
    { mode: 0o700 },
  );
  const result = spawnSync(
    "bash",
    [SCRIPT, "test-resolve", policy, addressMap, "127.0.0.1", "53"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OVD420_RECOVERY_EGRESS_TEST_RENDER: "1",
        PATH: `${binDirectory}:${process.env.PATH}`,
        TEST_DNS_ANSWER: answer,
      },
    },
  );
  return { addressMap, result };
}

function cnameChainRecords(depth) {
  const records = [];
  let owner = "approved.recovery.test";
  for (let index = 1; index <= depth; index += 1) {
    const target = `edge-${index}.recovery.test`;
    records.push(`${owner}. 60 IN CNAME ${target}.`);
    owner = target;
  }
  records.push(`${owner}. 60 IN A 93.184.216.34`);
  return records;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("OVD-420 recovery egress host control", () => {
  it("is valid Bash and mirrors the immutable Node topology", async () => {
    const syntax = runControl("--invalid-for-syntax-only");
    const source = await readFile(SCRIPT, "utf8");

    expect(syntax.status).toBe(64);
    expect(source).toContain(`readonly CONTRACT_ID='${CONTRACT.contractId}'`);
    expect(source).toContain(`readonly NETWORK_NAME='${CONTRACT.network}'`);
    expect(source).toContain(`readonly NETWORK_SUBNET='${CONTRACT.subnet}'`);
    expect(source).toContain(`readonly NETWORK_GATEWAY='${CONTRACT.gateway}'`);
    expect(source).toContain(`readonly NETWORK_BRIDGE='${CONTRACT.bridge}'`);
    expect(source).toContain(`readonly MAX_CNAME_DEPTH='${MAX_CNAME_DEPTH}'`);
    expect(source).toContain(
      "readonly INSTALL_PHASE_PATH='/run/ovd420-recovery-egress-install-phase'",
    );
    for (const phase of [
      "dependencies",
      "policy",
      "resolution",
      "network",
      "network-create",
      "network-contract",
      "network-ipv6",
      "network-ipv6-verify",
      "configuration",
      "firewall",
      "services",
      "verification",
    ]) {
      expect(source).toContain(`write_install_phase ${phase}`);
    }
    const installControl = source.slice(
      source.indexOf("install_control()"),
      source.indexOf("verify_control()"),
    );
    const teardownControl = source.slice(source.indexOf("teardown_control()"));
    expect(installControl.indexOf("write_install_phase resolution")).toBeLessThan(
      installControl.indexOf(
        'temporary_address_map="$(mktemp "$POLICY_DIR/.ovd420-addresses.XXXXXX")"',
      ),
    );
    const networkControl = source.slice(
      source.indexOf("ensure_network()"),
      source.indexOf("ensure_firewall()"),
    );
    expect(networkControl.indexOf("write_install_phase network-create")).toBeLessThan(
      networkControl.indexOf("docker network create"),
    );
    expect(networkControl.indexOf("write_install_phase network-contract")).toBeLessThan(
      networkControl.lastIndexOf("network_matches_contract"),
    );
    expect(networkControl.indexOf("write_install_phase network-ipv6")).toBeLessThan(
      networkControl.indexOf('sysctl -q -w "net.ipv6.conf.$NETWORK_BRIDGE.disable_ipv6=1"'),
    );
    expect(networkControl.indexOf("write_install_phase network-ipv6-verify")).toBeLessThan(
      networkControl.indexOf("ipv6_boundary_matches_contract || fail"),
    );
    expect(installControl.indexOf('verify_control "$digest"')).toBeLessThan(
      installControl.indexOf('rm -f "$INSTALL_PHASE_PATH"'),
    );
    expect(teardownControl).toContain('rm -f "$INSTALL_PHASE_PATH"');
    expect(
      spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" }).status,
    ).toBe(0);
  });

  it("atomically replaces the finite install phase with mode 0600", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd420-phase-"));
    temporaryDirectories.push(directory);
    const phasePath = path.join(directory, "phase");
    const chownRecord = path.join(directory, "chown-record");
    const functions = source
      .slice(source.indexOf("fail()"), source.indexOf("canonicalize_policy()"))
      .replace('mv -fT -- "$temporary_phase" "$INSTALL_PHASE_PATH"', 'mv -f -- "$temporary_phase" "$INSTALL_PHASE_PATH"');
    const harness = `set -euo pipefail
readonly INSTALL_PHASE_PATH="$TEST_PHASE_PATH"
chown() { printf '%s\\n' "$*" >>"$TEST_CHOWN_RECORD"; }
${functions}`;
    const success = spawnSync(
      "bash",
      ["-c", `${harness}\nwrite_install_phase resolution`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_CHOWN_RECORD: chownRecord,
          TEST_PHASE_PATH: phasePath,
        },
      },
    );
    expect(success.status, success.stderr).toBe(0);
    expect(await readFile(phasePath, "utf8")).toBe("resolution\n");
    expect((await stat(phasePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(chownRecord, "utf8")).toMatch(/^root:root .+\.tmp\.[A-Za-z0-9]+\n$/);
    expect((await readdir(directory)).sort()).toEqual([
      "chown-record",
      "phase",
    ]);

    const invalid = spawnSync(
      "bash",
      ["-c", `${harness}\nwrite_install_phase untrusted-detail`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_CHOWN_RECORD: chownRecord,
          TEST_PHASE_PATH: phasePath,
        },
      },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("install_phase_invalid");
    expect(await readFile(phasePath, "utf8")).toBe("resolution\n");
  });

  it("publishes the exact finite phase before every network failure boundary", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd420-network-phase-"));
    temporaryDirectories.push(directory);
    const phasePath = path.join(directory, "phase");
    const ensureNetwork = source.slice(
      source.indexOf("ensure_network()"),
      source.indexOf("ensure_ipv6_boundary()"),
    );
    const ensureIpv6 = source.slice(
      source.indexOf("ensure_ipv6_boundary()"),
      source.indexOf("ipv6_boundary_matches_contract()"),
    );
    const commonHarness = `set -euo pipefail
readonly NETWORK_NAME='ovd420-recovery-egress'
readonly NETWORK_SUBNET='172.28.42.0/29'
readonly NETWORK_GATEWAY='172.28.42.1'
readonly NETWORK_BRIDGE='ovd420-egress0'
write_install_phase() { printf '%s\\n' "$1" >"$TEST_PHASE_PATH"; }
fail() { printf '%s\\n' "$1" >&2; exit 1; }`;
    const runNetworkFailure = (inspectStatus, createStatus, contractStatus) =>
      spawnSync(
        "bash",
        [
          "-c",
          `${commonHarness}
docker() {
  if [[ "$1 $2" == 'network inspect' ]]; then return "$TEST_INSPECT_STATUS"; fi
  if [[ "$1 $2" == 'network create' ]]; then return "$TEST_CREATE_STATUS"; fi
  return 99
}
network_matches_contract() { return "$TEST_CONTRACT_STATUS"; }
${ensureNetwork}
ensure_network`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_CONTRACT_STATUS: String(contractStatus),
            TEST_CREATE_STATUS: String(createStatus),
            TEST_INSPECT_STATUS: String(inspectStatus),
            TEST_PHASE_PATH: phasePath,
          },
        },
      );

    const createFailure = runNetworkFailure(1, 1, 0);
    expect(createFailure.status).toBe(1);
    expect(createFailure.stderr).toContain("network_creation_failed");
    expect(await readFile(phasePath, "utf8")).toBe("network-create\n");

    const existingContractFailure = runNetworkFailure(0, 0, 1);
    expect(existingContractFailure.status).toBe(1);
    expect(existingContractFailure.stderr).toContain("network_contract_mismatch");
    expect(await readFile(phasePath, "utf8")).toBe("network-contract\n");

    const createdContractFailure = runNetworkFailure(1, 0, 1);
    expect(createdContractFailure.status).toBe(1);
    expect(createdContractFailure.stderr).toContain("network_creation_failed");
    expect(await readFile(phasePath, "utf8")).toBe("network-contract\n");

    const runIpv6Failure = (writeStatus, contractStatus) =>
      spawnSync(
        "bash",
        [
          "-c",
          `${commonHarness}
sysctl() {
  if [[ "$1" == '-q' && "$TEST_WRITE_STATUS" != '0' ]]; then return "$TEST_WRITE_STATUS"; fi
  return 0
}
ipv6_boundary_matches_contract() { return "$TEST_CONTRACT_STATUS"; }
${ensureIpv6}
ensure_ipv6_boundary`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_CONTRACT_STATUS: String(contractStatus),
            TEST_PHASE_PATH: phasePath,
            TEST_WRITE_STATUS: String(writeStatus),
          },
        },
      );

    const ipv6WriteFailure = runIpv6Failure(1, 0);
    expect(ipv6WriteFailure.status).toBe(1);
    expect(ipv6WriteFailure.stderr).toContain("ipv6_configuration_failed");
    expect(await readFile(phasePath, "utf8")).toBe("network-ipv6\n");

    const ipv6ReadbackFailure = runIpv6Failure(0, 1);
    expect(ipv6ReadbackFailure.status).toBe(1);
    expect(ipv6ReadbackFailure.stderr).toContain("ipv6_contract_mismatch");
    expect(await readFile(phasePath, "utf8")).toBe("network-ipv6-verify\n");
  });

  it("accepts only semantically empty Docker IPAM defaults across inspect serializers", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const networkContract = source.slice(
      source.indexOf("network_matches_contract()"),
      source.indexOf("ensure_network()"),
    );
    const baseNetwork = {
      Driver: "bridge",
      EnableIPv6: false,
      Internal: true,
      IPAM: {
        Driver: "default",
        Options: null,
        Config: [{ Subnet: CONTRACT.subnet, Gateway: CONTRACT.gateway }],
      },
      Options: { "com.docker.network.bridge.name": CONTRACT.bridge },
    };
    const runNetworkContract = (network) =>
      spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
readonly NETWORK_NAME='${CONTRACT.network}'
readonly NETWORK_SUBNET='${CONTRACT.subnet}'
readonly NETWORK_GATEWAY='${CONTRACT.gateway}'
readonly NETWORK_BRIDGE='${CONTRACT.bridge}'
docker() {
  [[ "$1 $2" == 'network inspect' ]] || return 99
  printf '%s\\n' "$TEST_DOCKER_INSPECT_JSON"
}
${networkContract}
network_matches_contract`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_DOCKER_INSPECT_JSON: JSON.stringify([network]),
          },
        },
      );

    expect(runNetworkContract(baseNetwork).status).toBe(0);
    expect(runNetworkContract({
      ...baseNetwork,
      IPAM: {
        ...baseNetwork.IPAM,
        Config: [{
          Subnet: CONTRACT.subnet,
          Gateway: CONTRACT.gateway,
          IPRange: "",
          AuxAddress: {},
          AuxiliaryAddresses: {},
        }],
      },
    }).status).toBe(0);
    expect(runNetworkContract({
      ...baseNetwork,
      IPAM: {
        ...baseNetwork.IPAM,
        Config: [{
          Subnet: CONTRACT.subnet,
          Gateway: CONTRACT.gateway,
          IPRange: "172.28.42.2/31",
        }],
      },
    }).status).not.toBe(0);
    expect(runNetworkContract({
      ...baseNetwork,
      IPAM: {
        ...baseNetwork.IPAM,
        Config: [{
          Subnet: CONTRACT.subnet,
          Gateway: CONTRACT.gateway,
          AuxiliaryAddresses: { reserved: "172.28.42.2" },
        }],
      },
    }).status).not.toBe(0);
    expect(runNetworkContract({
      ...baseNetwork,
      IPAM: {
        ...baseNetwork.IPAM,
        Config: [{
          Subnet: CONTRACT.subnet,
          Gateway: CONTRACT.gateway,
          Unexpected: "value",
        }],
      },
    }).status).not.toBe(0);
    expect(runNetworkContract({
      ...baseNetwork,
      IPAM: { ...baseNetwork.IPAM, Driver: "custom" },
    }).status).not.toBe(0);
    expect(runNetworkContract({
      ...baseNetwork,
      IPAM: { ...baseNetwork.IPAM, Options: { custom: "value" } },
    }).status).not.toBe(0);
    expect(runNetworkContract({
      ...baseNetwork,
      IPAM: { ...baseNetwork.IPAM, Options: false },
    }).status).not.toBe(0);
    for (const field of ["IPRange", "AuxAddress", "AuxiliaryAddresses"]) {
      expect(runNetworkContract({
        ...baseNetwork,
        IPAM: {
          ...baseNetwork.IPAM,
          Config: [{
            Subnet: CONTRACT.subnet,
            Gateway: CONTRACT.gateway,
            [field]: false,
          }],
        },
      }).status).not.toBe(0);
    }
  });

  it("owns Docker proof cleanup only after validating the returned network ID", async () => {
    const source = await readFile(NETWORK_PROOF, "utf8");
    const lifecycle = source.slice(
      source.indexOf("prove_exact_docker_network_lifecycle()"),
      source.indexOf("must_fail()"),
    );
    const cleanup = source.slice(
      source.indexOf("cleanup()"),
      source.indexOf("trap cleanup EXIT"),
    );

    expect(lifecycle.indexOf("docker_network_cleanup_unprovable='1'")).toBeLessThan(
      lifecycle.indexOf('[[ "$docker_network_id" =~ ^[0-9a-f]{64}$ ]]'),
    );
    expect(lifecycle.indexOf('[[ "$docker_network_id" =~ ^[0-9a-f]{64}$ ]]')).toBeLessThan(
      lifecycle.indexOf("docker_network_created='1'"),
    );
    expect(lifecycle.indexOf("docker_network_created='1'")).toBeLessThan(
      lifecycle.lastIndexOf('ip link show "$BRIDGE"'),
    );
    expect(cleanup).toContain('docker network rm "$docker_network_id"');
    expect(cleanup).not.toContain('docker network rm "$NETWORK_NAME"');
  });

  it("produces the same canonical policy digest as the Node contract", async () => {
    const file = await policyFile({
      version: 1,
      hostnames: ["WWW.XOMETRY.COM", "api.xometry.com"],
    });
    const expected = parseRecoveryEgressPolicy(await readFile(file));
    const result = runControl("validate", file);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(expected.digest);
  });

  it("renders production configs from a canonical pinned address map", async () => {
    const file = await policyFile({ version: 1, hostnames: ["approved.recovery.test"] });
    const directory = path.dirname(file);
    const addressMap = path.join(directory, "addresses.json");
    const dnsConfig = path.join(directory, "dnsmasq.conf");
    const haproxyConfig = path.join(directory, "haproxy.cfg");
    await writeFile(addressMap, JSON.stringify({
      version: 1,
      hosts: [{
        hostname: "approved.recovery.test",
        addresses: ["93.184.216.34", "93.184.216.35"],
      }],
    }));
    const result = renderTestConfig(file, addressMap, dnsConfig, haproxyConfig);

    expect(result.status).toBe(0);
    expect(await readFile(dnsConfig, "utf8")).toContain("host-record=approved.recovery.test,172.28.42.1");
    const haproxy = await readFile(haproxyConfig, "utf8");
    expect(haproxy).toContain("server upstream_0 93.184.216.34:443");
    expect(haproxy).toContain("server upstream_1 93.184.216.35:443");
    expect(haproxy).not.toContain("resolvers controlled_dns");
    expect(haproxy).not.toContain("approved.recovery.test:443");
    expect(runControl("test-render", file, addressMap, dnsConfig, haproxyConfig).status).toBe(1);
  });

  it("pins public addresses reached through a bounded DNS CNAME chain", async () => {
    const file = await policyFile({
      version: 1,
      hostnames: ["approved.recovery.test"],
    });
    const { addressMap, result } = await resolveFixture(
      file,
      [
        "approved.recovery.test. 60 IN CNAME edge.recovery.test.",
        "edge.recovery.test. 60 IN A 93.184.216.34",
        "edge.recovery.test. 60 IN A 93.184.216.35",
      ].join("\n"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(addressMap, "utf8"))).toEqual({
      version: 1,
      hosts: [
        {
          hostname: "approved.recovery.test",
          addresses: ["93.184.216.34", "93.184.216.35"],
        },
      ],
    });
  });

  it("pins a direct public address without a CNAME", async () => {
    const file = await policyFile({
      version: 1,
      hostnames: ["approved.recovery.test"],
    });
    const { addressMap, result } = await resolveFixture(
      file,
      "approved.recovery.test. 60 IN A 93.184.216.34",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(addressMap, "utf8"))).toEqual({
      version: 1,
      hosts: [
        {
          hostname: "approved.recovery.test",
          addresses: ["93.184.216.34"],
        },
      ],
    });
  });

  it("traverses a valid CNAME chain independently of answer order", async () => {
    const file = await policyFile({
      version: 1,
      hostnames: ["approved.recovery.test"],
    });
    const { addressMap, result } = await resolveFixture(
      file,
      [
        "edge-2.recovery.test. 60 IN A 93.184.216.34",
        "approved.recovery.test. 60 IN CNAME edge-1.recovery.test.",
        "edge-1.recovery.test. 60 IN CNAME edge-2.recovery.test.",
      ].join("\n"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(addressMap, "utf8"))).toEqual({
      version: 1,
      hosts: [
        {
          hostname: "approved.recovery.test",
          addresses: ["93.184.216.34"],
        },
      ],
    });
  });

  it.each([
    [
      "a disconnected answer owner",
      [
        "approved.recovery.test. 60 IN CNAME edge.recovery.test.",
        "unrelated.recovery.test. 60 IN A 93.184.216.34",
      ],
      "dns_answer_chain_invalid",
    ],
    [
      "a CNAME loop",
      [
        "approved.recovery.test. 60 IN CNAME edge.recovery.test.",
        "edge.recovery.test. 60 IN CNAME approved.recovery.test.",
      ],
      "dns_cname_loop",
    ],
    [
      "an IP-literal CNAME target",
      ["approved.recovery.test. 60 IN CNAME 192.0.2.1."],
      "dns_cname_invalid",
    ],
    [
      "a malformed answer owner",
      ["bad_owner.recovery.test. 60 IN A 93.184.216.34"],
      "dns_answer_name_invalid",
    ],
    [
      "a punycode CNAME target",
      ["approved.recovery.test. 60 IN CNAME xn--alias.recovery.test."],
      "dns_cname_invalid",
    ],
    [
      "a Unicode CNAME target",
      ["approved.recovery.test. 60 IN CNAME é.recovery.test."],
      "dns_cname_invalid",
    ],
    [
      "a private terminal address",
      [
        "approved.recovery.test. 60 IN CNAME edge.recovery.test.",
        "edge.recovery.test. 60 IN A 10.0.0.1",
      ],
      "dns_address_not_public",
    ],
    [
      "a CNAME after an address",
      [
        "approved.recovery.test. 60 IN A 93.184.216.34",
        "approved.recovery.test. 60 IN CNAME edge.recovery.test.",
      ],
      "dns_answer_chain_invalid",
    ],
    [
      "an address alongside a CNAME",
      [
        "approved.recovery.test. 60 IN CNAME edge.recovery.test.",
        "approved.recovery.test. 60 IN A 93.184.216.34",
      ],
      "dns_answer_chain_invalid",
    ],
    [
      "two CNAME targets for one owner",
      [
        "approved.recovery.test. 60 IN CNAME edge-1.recovery.test.",
        "approved.recovery.test. 60 IN CNAME edge-2.recovery.test.",
      ],
      "dns_answer_chain_invalid",
    ],
  ])("rejects %s", async (_label, records, failureCode) => {
    const file = await policyFile({
      version: 1,
      hostnames: ["approved.recovery.test"],
    });
    const { result } = await resolveFixture(file, records.join("\n"));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(failureCode);
  });

  it("accepts a CNAME chain at the fixed depth limit", async () => {
    const file = await policyFile({
      version: 1,
      hostnames: ["approved.recovery.test"],
    });
    const { addressMap, result } = await resolveFixture(
      file,
      cnameChainRecords(MAX_CNAME_DEPTH).join("\n"),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(addressMap, "utf8"))).toEqual({
      version: 1,
      hosts: [
        {
          hostname: "approved.recovery.test",
          addresses: ["93.184.216.34"],
        },
      ],
    });
  });

  it("rejects a CNAME chain deeper than the fixed limit", async () => {
    const file = await policyFile({
      version: 1,
      hostnames: ["approved.recovery.test"],
    });
    const { result } = await resolveFixture(
      file,
      cnameChainRecords(MAX_CNAME_DEPTH + 1).join("\n"),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dns_cname_chain_too_deep");
  });

  it.each([
    ["private address", ["10.0.0.1"]],
    ["link-local address", ["169.254.169.254"]],
    ["loopback address", ["127.0.0.1"]],
    ["IPv6 address", ["2001:db8::1"]],
    ["non-canonical IPv4 address", ["093.184.216.34"]],
    ["unsorted addresses", ["93.184.216.35", "93.184.216.34"]],
    ["duplicate addresses", ["93.184.216.34", "93.184.216.34"]],
  ])("rejects a %s in the pinned address map", async (_label, addresses) => {
    const file = await policyFile({ version: 1, hostnames: ["approved.recovery.test"] });
    const directory = path.dirname(file);
    const addressMap = path.join(directory, "addresses.json");
    const dnsConfig = path.join(directory, "dnsmasq.conf");
    const haproxyConfig = path.join(directory, "haproxy.cfg");
    await writeFile(addressMap, JSON.stringify({
      version: 1,
      hosts: [{ hostname: "approved.recovery.test", addresses }],
    }));

    const result = renderTestConfig(file, addressMap, dnsConfig, haproxyConfig);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/address_map_(?:invalid|address_not_public)/);
  });

  it("rejects hostname scope drift in the pinned address map", async () => {
    const file = await policyFile({ version: 1, hostnames: ["approved.recovery.test"] });
    const directory = path.dirname(file);
    const addressMap = path.join(directory, "addresses.json");
    await writeFile(addressMap, JSON.stringify({
      version: 1,
      hosts: [{ hostname: "attacker.test", addresses: ["93.184.216.34"] }],
    }));

    const result = renderTestConfig(
      file,
      addressMap,
      path.join(directory, "dnsmasq.conf"),
      path.join(directory, "haproxy.cfg"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("address_map_invalid");
  });

  it.each([
    ["unsupported version", { version: 2, hostnames: ["api.xometry.com"] }],
    ["empty", { version: 1, hostnames: [] }],
    ["wildcard", { version: 1, hostnames: ["*.xometry.com"] }],
    ["IP literal", { version: 1, hostnames: ["192.0.2.1"] }],
    ["Unicode", { version: 1, hostnames: ["éxample.com"] }],
    ["punycode", { version: 1, hostnames: ["xn--xample-9ua.com"] }],
    ["duplicate", { version: 1, hostnames: ["API.XOMETRY.COM", "api.xometry.com"] }],
    ["unknown field", { version: 1, hostnames: ["api.xometry.com"], allowAll: true }],
  ])("rejects %s policies before privileged setup", async (_label, policy) => {
    const file = await policyFile(policy);
    const result = runControl("validate", file);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("policy_invalid");
    expect(result.stderr).not.toContain("xometry.com");
  });

  it("fails closed when controlled DNS is unavailable", async () => {
    const file = await policyFile({ version: 1, hostnames: ["approved.recovery.test"] });
    const addressMap = path.join(path.dirname(file), "addresses.json");
    await writeFile(addressMap, JSON.stringify({
      version: 1,
      hosts: [{ hostname: "approved.recovery.test", addresses: ["93.184.216.34"] }],
    }));

    const result = spawnSync(
      "bash",
      [SCRIPT, "test-resolution-match", file, addressMap, "127.0.0.1", "9"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, OVD420_RECOVERY_EGRESS_TEST_RENDER: "1" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dns_resolution_unavailable");
  });

  it("uses one internal network and launcher for both recovery modes", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const dockerRuns = source.match(/docker run --rm -it/g) ?? [];
    const launcher = source.slice(
      source.indexOf("launch_browser()"),
      source.indexOf("teardown_control()"),
    );

    expect(source).toContain("--internal");
    expect(source).toContain('tcp-request inspect-delay 5s');
    expect(source).toContain('req.ssl_sni -i %s');
    expect(source).toContain(
      'tcp-request content accept if tls_client_hello approved_sni_%d',
    );
    expect(
      source.indexOf(
        'tcp-request content accept if tls_client_hello approved_sni_%d',
      ),
    ).toBeLessThan(
      source.indexOf("'  tcp-request content reject if tls_client_hello'"),
    );
    expect(source).toContain('host-record=%s,%s');
    expect(source).toContain('server upstream_%d %s:443');
    expect(source).not.toContain('resolvers controlled_dns');
    expect(source).toContain("--network \"$NETWORK_NAME\"");
    expect(source).toContain("--dns \"$NETWORK_GATEWAY\"");
    expect(source).toContain("--ipc=host");
    expect(source).toContain("Camoufox MIT-SHM reaches host Xvfb");
    expect(source).toContain("--cap-drop ALL");
    expect(source).toContain("--security-opt no-new-privileges");
    expect(source).toContain("--env HTTP_PROXY=");
    expect(source).toContain("--env HTTPS_PROXY=");
    expect(source).toContain("mode\" == 'classifier-only'");
    expect(source).toContain("mode\" == 'full-recovery'");
    expect(dockerRuns).toHaveLength(1);
    expect(launcher.indexOf('verify_control "$expected_digest"')).toBeGreaterThan(
      -1,
    );
    expect(launcher.indexOf('verify_control "$expected_digest"')).toBeLessThan(
      launcher.indexOf("docker run --rm -it"),
    );
    expect(launcher.match(/--network(?:=|\s+)/g)).toHaveLength(1);
  });

  it.each([
    ["classifier-only", "ovd410-xometry-classifier-diagnostic"],
    ["full-recovery", "ovd410-xometry-auth-recovery"],
  ])("executes the real %s launch only after readiness passes", async (mode, containerName) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd420-launch-"));
    temporaryDirectories.push(directory);
    const record = path.join(directory, "record.txt");
    const result = runLaunchHarness(mode, directory, record);
    const lines = (await readFile(record, "utf8")).trim().split("\n");

    expect(result.status).toBe(0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`verify:${"b".repeat(64)}`);
    expect(lines[1]).toContain(`--name ${containerName}`);
    expect(lines[1]).toContain("--network ovd420-recovery-egress");
    expect(lines[2]).toBe(`verify:${"b".repeat(64)}`);
  });

  it("maps both launch modes to their production credential directories", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "$CONTROL_SCRIPT"
credential_directory_for_mode classifier-only
credential_directory_for_mode full-recovery`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CONTROL_SCRIPT: SCRIPT },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "/var/lib/ovd410-classifier-diagnostic\n/var/lib/ovd410-credential\n",
    );
  });

  it.each(["classifier-only", "full-recovery"])(
    "blocks the real %s launch when readiness fails",
    async (mode) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "ovd420-launch-"));
      temporaryDirectories.push(directory);
      const record = path.join(directory, "record.txt");
      const result = runLaunchHarness(mode, directory, record, 1);
      const recordText = await readFile(record, "utf8");

      expect(result.status).toBe(1);
      expect(recordText).toBe(`verify:${"b".repeat(64)}\n`);
      expect(result.stderr).toContain("test_verification_failed");
    },
  );

  it("removes the broad metadata DNS exception and verifies ordered terminal denies", async () => {
    const source = await readFile(SCRIPT, "utf8");

    expect(source).toContain(
      "iptables -D DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT",
    );
    expect(source).toContain(
      "iptables -D DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT",
    );
    expect(source).toContain("first_input_rule");
    expect(source).toContain("first_forward_rule");
    expect(source).toContain("expected_input_rules");
    expect(source).toContain("expected_forward_rules");
    expect(source).toContain("network_has_no_containers");
    expect(source).toContain("rendered_configs_match");
    expect(source).toContain("units_match_contract");
    expect(source).toContain("listener_owned_by_unit");
    expect(source).toContain("DropInPaths");
    expect(source).toContain("NeedDaemonReload");
    expect(source).toContain("FragmentPath");
    expect(source).toContain("MainPID");
    expect(source).toContain("ControlGroup");
    expect(source).toContain("/proc/$main_pid/exe");
    expect(source).toContain("/proc/$pid/exe");
    expect(source).toContain("pid_in_unit_cgroup");
    expect(source).toContain("service_unit_identity_mismatch");
    expect(source).toContain("dns_tcp_listener_identity_mismatch");
    expect(source).toContain("dns_udp_listener_identity_mismatch");
    expect(source).toContain("gateway_listener_identity_mismatch");
    expect(source).toContain("address_map_matches_controlled_resolution");
    expect(source).toContain("test-resolution-match");
    expect(source).toContain("test_address_map_resolution_drift");
    expect(source).toContain("ensure_ipv6_boundary");
    expect(source).toContain("ipv6_boundary_matches_contract");
    expect(source).toContain("ipv6_contract_mismatch");
    expect(source).toContain(
      'sysctl -q -w "net.ipv6.conf.$NETWORK_BRIDGE.disable_ipv6=1"',
    );
    expect(source).toContain(
      "Exact equality is deliberate: DNS drift requires OVD-410 requalification.",
    );
    expect(source).toContain("verify_gateway_resolution");
    expect(source).toContain("systemctl restart \"$DNS_SERVICE\" \"$GATEWAY_SERVICE\"");
    expect(source).toContain("User=dnsmasq");
    expect(source).toContain("User=haproxy");
    expect(source).toContain("ExecStart=$DNS_EXECUTABLE");
    expect(source).toContain("ExecStart=$GATEWAY_EXECUTABLE");
    expect(source).toContain("Requires=$DNS_SERVICE");
    expect(source).toContain("--sysctl net.ipv6.conf.all.disable_ipv6=1");
    expect(source).toContain("--sysctl net.ipv6.conf.default.disable_ipv6=1");
    expect(source).toContain("render_dns_unit | install -o root -g root -m 0644");
    expect(source).toContain("render_gateway_unit | install -o root -g root -m 0644");
    expect(source).not.toContain("stats socket");
  });

  it("keeps verification output sanitized", async () => {
    const source = await readFile(SCRIPT, "utf8");

    expect(source).not.toContain("set -x");
    expect(source).not.toContain("log-queries");
    expect(source).not.toContain("show stat");
    expect(source).toContain("dns_address_not_public");
    expect(source).toContain(
      "contract=$CONTRACT_ID policy_sha256=$actual_digest",
    );
  });

  it("makes post-launch verification authoritative without leaking its output", async () => {
    const source = await readFile(SCRIPT, "utf8");
    const launcher = source.slice(
      source.indexOf("launch_browser()"),
      source.indexOf("teardown_control()"),
    );
    const postLaunchStart = launcher.indexOf(
      'if ! ( verify_control "$expected_digest" >/dev/null 2>&1 ); then',
    );
    const postLaunch = launcher.slice(
      postLaunchStart,
      launcher.lastIndexOf("\n}"),
    );
    const runPostLaunch = (verifyStatus, commandStatus) =>
      spawnSync(
        "bash",
        [
          "-c",
          `fail() {
  local failure_code="$1"
  printf '%s\n' "OVD-420 recovery egress control failed: $failure_code" >&2
  exit 1
}
verify_control() {
  printf '%s\\n' 'misleading readiness'
  printf '%s\\n' 'sensitive verification detail' >&2
  exit "$VERIFY_STATUS"
}
post_launch() {
  local expected_digest='${"a".repeat(64)}'
  local command_status="$COMMAND_STATUS"
${postLaunch}
}
post_launch`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            VERIFY_STATUS: String(verifyStatus),
            COMMAND_STATUS: String(commandStatus),
          },
        },
      );

    expect(postLaunchStart).toBeGreaterThan(-1);
    const browserFailure = runPostLaunch(0, 7);
    expect(browserFailure.status).toBe(7);
    expect(browserFailure.stdout).toBe("");
    expect(browserFailure.stderr).toBe("");

    const verificationFailure = runPostLaunch(1, 7);
    expect(verificationFailure.status).toBe(1);
    expect(verificationFailure.stdout).toBe("");
    expect(verificationFailure.stderr).toContain(
      "post_launch_verification_failed",
    );
    expect(verificationFailure.stderr).not.toContain(
      "sensitive verification detail",
    );
  });

  it("starts the unprivileged HAProxy proof from its traversable fixture directory", async () => {
    const source = await readFile(NETWORK_PROOF, "utf8");
    const haproxyStart = source.slice(
      source.indexOf('haproxy_uid="$(id -u haproxy)"'),
      source.indexOf("haproxy_pid=\"$!\""),
    );
    const serviceStart = source.indexOf("start_synthetic_services()");
    const readinessStart = source.indexOf("local attempts=0", serviceStart);
    const readinessLoop = source.slice(
      readinessStart,
      source.indexOf("\n  done", readinessStart),
    );

    expect(haproxyStart).toContain('cd "$work_dir"');
    expect(haproxyStart).toContain(
      'haproxy -f "$work_dir/haproxy.cfg"',
    );
    expect(haproxyStart.indexOf('cd "$work_dir"')).toBeLessThan(
      haproxyStart.indexOf("exec setpriv"),
    );
    expect(readinessLoop).toContain(
      'endpoint="$SYNTHETIC_ORIGIN:443"',
    );
    expect(readinessLoop.indexOf("$SYNTHETIC_ORIGIN:443")).toBeLessThan(
      readinessLoop.indexOf("$NETWORK_GATEWAY:443"),
    );
    expect(source).toContain("must_be_forward_rejected");
    expect(source).toContain("forward_reject_packets");
    expect(source).toContain("after > before");
    expect(source).toContain(
      "cname=$APPROVED_HOST,$APPROVED_HOST_ALIAS",
    );
    expect(source).toContain(
      "host-record=$APPROVED_HOST_ALIAS,$address",
    );
    expect(source).toContain(
      'sysctl -q -w "net.ipv6.conf.$BRIDGE.disable_ipv6=1"',
    );
  });
});
