import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OVD410_RECOVERY_HOST_CONTRACT as CONTRACT } from "./xometry-recovery-host-contract.mjs";
import { teardownRecoveryHost } from "./teardown-ovd410-recovery-host.mjs";

function testEnvironment(overrides = {}) {
  return {
    GOOGLE_CLOUD_PROJECT: CONTRACT.project,
    OVD410_IAP_INITIAL_STATE: "DISABLED",
    OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED: "TRUE",
    ...overrides,
  };
}

function commandKind(args) {
  if (args.includes("instances")) return "vm";
  if (args.includes("firewall-rules")) return "firewall";
  if (args.includes("repositories")) return "repository-binding";
  if (args.includes("service-accounts")) return "recovery-service-account";
  if (args.includes("services")) return "iap-restoration";
  throw new Error("unexpected command");
}

function isReadback(args) {
  return args.includes("list") || args.includes("get-iam-policy");
}

describe("OVD-410 recovery compensating teardown", () => {
  it("handles partial setup and proves every resource absent", async () => {
    const calls = [];
    const output = [];
    const code = await teardownRecoveryHost({
      env: testEnvironment(),
      output: { write: (value) => output.push(value) },
      runCommand: async (args) => {
        calls.push(args);
        const kind = commandKind(args);
        if (!isReadback(args) && ["vm", "repository-binding"].includes(kind)) {
          throw new Error("resource was never created");
        }
        if (kind === "repository-binding" && isReadback(args)) {
          return JSON.stringify({ bindings: [] });
        }
        return "";
      },
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(10);
    expect(new Set(calls.map(commandKind))).toEqual(
      new Set([
        "vm",
        "firewall",
        "repository-binding",
        "recovery-service-account",
        "iap-restoration",
      ]),
    );
    expect(output.join("")).toContain("final readbacks are clean");
  });

  it("does not skip later cleanup when one deletion fails and fails on residue", async () => {
    const calls = [];
    const output = [];
    const code = await teardownRecoveryHost({
      env: testEnvironment(),
      output: { write: (value) => output.push(value) },
      runCommand: async (args) => {
        calls.push(args);
        const kind = commandKind(args);
        if (kind === "vm" && !isReadback(args))
          throw new Error("delete failed");
        if (kind === "vm" && isReadback(args)) return `${CONTRACT.instance}\n`;
        if (kind === "repository-binding" && isReadback(args)) {
          return JSON.stringify({ bindings: [] });
        }
        return "";
      },
    });

    expect(code).toBe(1);
    expect(calls.findIndex((args) => commandKind(args) === "vm")).toBeLessThan(
      calls.findIndex((args) => commandKind(args) === "firewall"),
    );
    expect(calls.filter((args) => !isReadback(args)).map(commandKind)).toEqual([
      "vm",
      "firewall",
      "repository-binding",
      "recovery-service-account",
      "iap-restoration",
    ]);
    expect(calls.filter(isReadback)).toHaveLength(5);
    expect(output.join("")).toContain("residue=vm");
  });

  it("preserves enabled IAP when restoration is not authorized", async () => {
    const calls = [];
    const code = await teardownRecoveryHost({
      env: testEnvironment({
        OVD410_IAP_INITIAL_STATE: "ENABLED",
        OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED: "FALSE",
      }),
      output: { write: () => undefined },
      runCommand: async (args) => {
        calls.push(args);
        const kind = commandKind(args);
        if (kind === "repository-binding" && isReadback(args)) {
          return JSON.stringify({ bindings: [] });
        }
        if (kind === "iap-restoration" && isReadback(args))
          return `${CONTRACT.iapService}\n`;
        return "";
      },
    });

    expect(code).toBe(0);
    expect(
      calls.some((args) => args[0] === "services" && args[1] === "disable"),
    ).toBe(false);
  });

  it("treats a deleted recovery principal repository binding as residue", async () => {
    const output = [];
    const code = await teardownRecoveryHost({
      env: testEnvironment(),
      output: { write: (value) => output.push(value) },
      runCommand: async (args) => {
        const kind = commandKind(args);
        if (kind === "repository-binding" && isReadback(args)) {
          return JSON.stringify({
            bindings: [
              {
                role: CONTRACT.recoveryRole,
                members: [
                  `deleted:serviceAccount:${CONTRACT.recoveryServiceAccount}?uid=123456789`,
                ],
              },
            ],
          });
        }
        return "";
      },
    });

    expect(code).toBe(1);
    expect(output.join("")).toContain("residue=repository-binding");
  });
});

describe("OVD-410 classifier-only runbook contract", () => {
  it("keeps the diagnostic hash-locked and separate from snapshot recovery", async () => {
    const source = await readFile(
      "docs/workflows/ovd410-stable-egress.md",
      "utf8",
    );
    const diagnostic = source.slice(
      source.indexOf("### Classifier-only diagnostic exception after probe A"),
      source.indexOf(
        "Before opening the provider, complete the destructive half",
      ),
    );
    const command = diagnostic.slice(
      diagnostic.indexOf("OVD410_CLASSIFIER_COMMAND_EOF'") +
        "OVD410_CLASSIFIER_COMMAND_EOF'".length,
      diagnostic.indexOf("OVD410_CLASSIFIER_COMMAND_EOF\n)"),
    );

    expect(diagnostic).toContain("OVD410_CLASSIFIER_PAYLOAD_SHA256");
    expect(diagnostic).toContain(
      "printf '%s\\n' \"$OVD410_CLASSIFIER_PAYLOAD\"",
    );
    expect(diagnostic).not.toContain("XOMETRY_RECOVERY_SNAPSHOT_ACCESS_PHASE");
    expect(command).toContain("node dist/tools/xometryAuth.js");
    expect(command).toContain("OVD410_RECOVERY_MODE:?}");
    expect(command).toContain("sudo docker run --rm -it");
    expect(command).not.toContain("XOMETRY_PROFILE_SNAPSHOT_BUCKET");
    expect(command).not.toContain("XOMETRY_PROFILE_SNAPSHOT_OBJECT");
    expect(command).not.toContain("exportXometryProfile");
    expect(command).not.toContain("gcloud storage");
    expect(command).not.toContain("compute scp");
    expect(diagnostic).toContain("--ssh-flag='-N'");
    expect(diagnostic).toContain(
      "--ssh-flag='-L127.0.0.1:6080:127.0.0.1:6080'",
    );
    expect(diagnostic).toContain(
      "http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale",
    );
    expect(diagnostic).toContain("human account owner");
    const trapIndex = diagnostic.indexOf("trap 'ovd410_status=$?;");
    const launchIndex = diagnostic.lastIndexOf(
      "gcloud compute ssh overdrafter-xometry-auth-recovery",
    );
    expect(trapIndex).toBeGreaterThan(-1);
    expect(trapIndex).toBeLessThan(launchIndex);
    expect(diagnostic).toContain(
      'trap "" HUP INT TERM; trap - EXIT; cleanup_ovd410_classifier_diagnostic',
    );
    expect(diagnostic).toContain("trap 'exit 130' INT");
    expect(diagnostic).toContain("trap '' HUP INT TERM");
    expect(diagnostic.indexOf("trap '' HUP INT TERM")).toBeLessThan(
      diagnostic.indexOf("node scripts/teardown-ovd410-recovery-host.mjs"),
    );
    const cleanupBody = diagnostic.slice(
      diagnostic.indexOf("cleanup_ovd410_classifier_diagnostic()"),
      diagnostic.indexOf("trap 'ovd410_status=$?;"),
    );
    expect(cleanupBody).not.toContain("gcloud compute ssh");
    expect(cleanupBody).toContain(
      "node scripts/teardown-ovd410-recovery-host.mjs",
    );
    expect(diagnostic).toContain(
      "OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED='TRUE'",
    );
    expect(diagnostic).toContain(
      "export OVD410_IAP_INITIAL_STATE OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED",
    );
    expect(cleanupBody).toContain(
      'OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED="$OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED"',
    );
    expect(diagnostic).not.toContain("trap - EXIT HUP INT TERM");
    expect(diagnostic).toContain("teardown-ovd410-recovery-host.mjs");
    expect(diagnostic).toContain("install -o root -g root -m 0700 /dev/stdin");
    expect(diagnostic).toContain("root:root:700");
    expect(diagnostic).toContain("--ssh-flag='-t'");
    expect(diagnostic).not.toContain("--command='sudo bash -s'");
    expect(diagnostic).toContain(
      "sudo bash '$OVD410_CLASSIFIER_REMOTE_PAYLOAD'",
    );
    const stageIndex = diagnostic.indexOf(
      "# Stage only the already-hashed bytes",
    );
    const remoteVerifyIndex = diagnostic.indexOf(
      "OVD410_CLASSIFIER_REMOTE_SHA256=",
    );
    const interactiveIndex = diagnostic.indexOf("# Reverify the staged bytes");
    expect(stageIndex).toBeGreaterThan(trapIndex);
    expect(remoteVerifyIndex).toBeGreaterThan(stageIndex);
    expect(interactiveIndex).toBeGreaterThan(remoteVerifyIndex);
    expect(diagnostic).toContain("length == 11");
    expect(diagnostic).toContain(
      'test "$OVD410_CLASSIFIER_EXECUTION_AFTER" = "$OVD410_CLASSIFIER_EXECUTION_BASELINE"',
    );
    expect(diagnostic).toMatch(/ordinary\s+stable-egress verifier/);
    expect(diagnostic).toContain("zero NAT mappings");
    expect(diagnostic).toContain("private service, Job, and");
    expect(diagnostic).toContain("checked-in sanitized operational-envelope");
    expect(diagnostic).toMatch(
      /queue\/request counts and ID\/status-only\s+fingerprints/,
    );
    expect(diagnostic).toContain("snapshot generation, size");
    const postEnvelopeIndex = diagnostic.indexOf(
      "# Complete the containment envelope before returning",
    );
    const explicitCleanupIndex = diagnostic.indexOf(
      "cleanup_ovd410_classifier_diagnostic 0",
    );
    const normalStatusIndex = diagnostic.indexOf(
      'OVD410_CLASSIFIER_STATUS="$?"',
    );
    const normalIgnoreIndex = diagnostic.indexOf(
      "trap '' HUP INT TERM",
      normalStatusIndex,
    );
    const normalClearExitIndex = diagnostic.indexOf(
      "trap - EXIT",
      normalStatusIndex,
    );
    expect(normalIgnoreIndex).toBeGreaterThan(normalStatusIndex);
    expect(normalIgnoreIndex).toBeLessThan(normalClearExitIndex);
    expect(normalClearExitIndex).toBeLessThan(explicitCleanupIndex);
    const restoredSignalsIndex = diagnostic.indexOf(
      "trap - HUP INT TERM",
      explicitCleanupIndex,
    );
    expect(restoredSignalsIndex).toBeGreaterThan(explicitCleanupIndex);
    expect(restoredSignalsIndex).toBeLessThan(postEnvelopeIndex);
    expect(
      diagnostic.indexOf("trap '' HUP INT TERM", restoredSignalsIndex),
    ).toBe(-1);
    const finalExitIndex = diagnostic.indexOf(
      'exit "$OVD410_CLASSIFIER_STATUS"',
    );
    expect(postEnvelopeIndex).toBeGreaterThan(interactiveIndex);
    expect(postEnvelopeIndex).toBeLessThan(finalExitIndex);
    const postEnvelope = diagnostic.slice(postEnvelopeIndex, finalExitIndex);
    expect(postEnvelope).toContain("npm run verify:xometry-egress");
    expect(postEnvelope).toContain(
      "node scripts/verify-ovd373-billing-disabled.mjs",
    );
    expect(postEnvelope).toContain(
      'test "$OVD410_CLASSIFIER_OPERATIONAL_AFTER" = "$OVD410_CLASSIFIER_OPERATIONAL_BASELINE"',
    );
    expect(postEnvelope).toContain(
      'test "$OVD410_CLASSIFIER_SNAPSHOT_AFTER" = "$OVD410_CLASSIFIER_SNAPSHOT_BASELINE"',
    );
    expect(postEnvelope).toContain(
      'test "$OVD410_CLASSIFIER_SNAPSHOT_IAM_AFTER" = "$OVD410_CLASSIFIER_SNAPSHOT_IAM_BASELINE"',
    );
    expect(diagnostic).toContain("collect_ovd410_snapshot_iam()");
    expect(diagnostic).toContain("gcloud 558 requests IAM policy version 3");
    expect(diagnostic).toContain("Do not assert an unreturned");
    expect(diagnostic).not.toContain(".version != 3");
    expect(diagnostic).toContain("jq -ceS");
    expect(diagnostic).not.toContain("[.bindings[]? | {role, members:");
    expect(diagnostic).not.toContain("OVD410_PRODUCTION_DATABASE_URL");
    expect(diagnostic).not.toContain("psql");
    expect(diagnostic).toContain("gcloud secrets versions access latest");
    expect(diagnostic).toContain("--secret supabase-service-role-key");
    expect(diagnostic).toContain(
      'SUPABASE_SERVICE_ROLE_KEY="$service_role_secret"',
    );
    expect(diagnostic).toContain(
      "node scripts/collect-ovd410-operational-envelope.mjs",
    );
    const collectorFunction = diagnostic.slice(
      diagnostic.indexOf("collect_ovd410_operational_envelope()"),
      diagnostic.indexOf("OVD410_CLASSIFIER_OPERATIONAL_BASELINE="),
    );
    expect(collectorFunction).not.toContain("export service_role_secret");
    expect(collectorFunction.match(/unset service_role_secret/g)).toHaveLength(
      2,
    );
    const requestStartIndex = diagnostic.indexOf(
      "OVD410_CLASSIFIER_STARTED_AT=",
    );
    expect(requestStartIndex).toBeGreaterThan(remoteVerifyIndex);
    expect(requestStartIndex).toBeLessThan(
      diagnostic.indexOf("set +e", requestStartIndex),
    );
    expect(postEnvelope).toContain("for OVD410_LOG_OBSERVATION in 1 2 3");
    expect(postEnvelope).toContain("OVD410_CLASSIFIER_SERVICE_REQUEST=");
    expect(postEnvelope).toContain("gcloud logging read");
    expect(postEnvelope).toContain("run.googleapis.com%2Frequests");
    expect(postEnvelope).toContain("--format='json(timestamp)'");
    expect(postEnvelope).not.toContain("insertId");
    expect(postEnvelope).toContain("jq -e 'type == \"array\" and length == 0'");
    expect(postEnvelope).toContain("sleep 15");
    expect(
      postEnvelope.indexOf("OVD410_CLASSIFIER_SERVICE_REQUEST="),
    ).toBeGreaterThan(
      postEnvelope.indexOf(
        'test "$OVD410_CLASSIFIER_SNAPSHOT_IAM_AFTER" = "$OVD410_CLASSIFIER_SNAPSHOT_IAM_BASELINE"',
      ),
    );
    expect(diagnostic).toContain("no independent consumer or");
    expect(diagnostic).toContain("remains current for the entire diagnostic");
    expect(diagnostic).toContain("Stop on contrary");
    expect(diagnostic).toContain("any admitted schema or");
    expect(diagnostic).toContain("external quiescence invariant");
  });

  it("canonicalizes the complete observable conditional IAM policy", async () => {
    const source = await readFile(
      "docs/workflows/ovd410-stable-egress.md",
      "utf8",
    );
    const canonicalizer = source.match(/\| jq -ceS '\n([\s\S]*?)\n\s*'/)?.[1];
    expect(canonicalizer).toBeDefined();

    const policy = {
      bindings: [
        {
          role: "roles/storage.objectViewer",
          members: ["serviceAccount:fixture@example.iam.gserviceaccount.com"],
          condition: {
            title: "bounded fixture",
            expression: "request.time < timestamp('2030-01-01T00:00:00Z')",
          },
        },
      ],
      etag: "BwYFixtureEtag=",
    };
    const result = spawnSync("jq", ["-ceS", canonicalizer], {
      input: JSON.stringify(policy),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(policy);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("version");

    const malformed = spawnSync("jq", ["-ceS", canonicalizer], {
      input: JSON.stringify([]),
      encoding: "utf8",
    });
    expect(malformed.status).not.toBe(0);
  });
});
