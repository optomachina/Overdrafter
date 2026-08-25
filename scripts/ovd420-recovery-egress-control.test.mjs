import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OVD420_RECOVERY_EGRESS_CONTRACT as CONTRACT,
  parseRecoveryEgressPolicy,
} from "./ovd420-recovery-egress-contract.mjs";

const SCRIPT = "scripts/ovd420-recovery-egress-control.sh";
const NETWORK_PROOF = "scripts/verify-ovd420-recovery-egress-network.sh";
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

function renderTestConfig(policy, addressMap, dnsConfig, haproxyConfig) {
  return spawnSync("bash", [SCRIPT, "test-render", policy, addressMap, dnsConfig, haproxyConfig], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, OVD420_RECOVERY_EGRESS_TEST_RENDER: "1" },
  });
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
    expect(
      spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" }).status,
    ).toBe(0);
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
    expect(source).toContain("address_map_matches_controlled_resolution");
    expect(source).toContain(
      "Exact equality is deliberate: DNS drift requires OVD-410 requalification.",
    );
    expect(source).toContain("verify_gateway_resolution");
    expect(source).toContain("systemctl restart \"$DNS_SERVICE\" \"$GATEWAY_SERVICE\"");
    expect(source).toContain("User=dnsmasq");
    expect(source).toContain("User=haproxy");
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
  });
});
