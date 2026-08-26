#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDirectCli } from "./xometry-stable-egress-contract.mjs";
import { OVD410_RECOVERY_HOST_CONTRACT } from "./xometry-recovery-host-contract.mjs";

const execFileAsync = promisify(execFile);
const CLOUD_TIMEOUT_MS = 10 * 60_000;

async function defaultRunCommand(args, gcloudBin) {
  const { stdout = "" } = await execFileAsync(gcloudBin, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: CLOUD_TIMEOUT_MS,
  });
  return stdout;
}

function iapRestorationMode(env) {
  if (!["DISABLED", "ENABLED"].includes(env.OVD410_IAP_INITIAL_STATE))
    return null;
  const noIndependentUse = env.OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED;
  if (
    noIndependentUse !== undefined &&
    !["TRUE", "FALSE"].includes(noIndependentUse)
  ) {
    return null;
  }
  return env.OVD410_IAP_INITIAL_STATE === "DISABLED" &&
    noIndependentUse === "TRUE"
    ? "disable"
    : "preserve-enabled";
}

function recoveryMember(contract) {
  return `serviceAccount:${contract.recoveryServiceAccount}`;
}

function parsePolicy(stdout) {
  const policy = JSON.parse(stdout);
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("invalid policy");
  }
  const bindings = policy.bindings ?? [];
  if (!Array.isArray(bindings)) throw new Error("invalid bindings");
  for (const binding of bindings) {
    if (
      binding === null ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      typeof binding.role !== "string" ||
      binding.role.length === 0 ||
      !Array.isArray(binding.members) ||
      binding.members.length === 0 ||
      binding.members.some(
        (candidate) =>
          typeof candidate !== "string" || candidate.length === 0,
      )
    ) {
      throw new Error("invalid binding");
    }
    if (binding.condition !== undefined) {
      const condition = binding.condition;
      if (
        condition === null ||
        typeof condition !== "object" ||
        Array.isArray(condition) ||
        typeof condition.title !== "string" ||
        condition.title.length === 0 ||
        typeof condition.expression !== "string" ||
        condition.expression.length === 0 ||
        (condition.description !== undefined &&
          typeof condition.description !== "string")
      ) {
        throw new Error("invalid binding condition");
      }
    }
  }
  return bindings;
}

function isRecoveryMember(candidate, member) {
  if (candidate === member) return true;
  if (typeof candidate !== "string") return false;
  const tombstonePrefix = `deleted:${member}?uid=`;
  if (!candidate.startsWith(tombstonePrefix)) return false;
  return /^\d+$/.test(candidate.slice(tombstonePrefix.length));
}

function policyMembers(stdout, member, role, requireUnconditional = false) {
  return parsePolicy(stdout).flatMap((binding) => {
    if (role !== undefined && binding?.role !== role) return [];
    if (requireUnconditional && binding?.condition !== undefined) return [];
    return binding.members.filter((candidate) =>
      isRecoveryMember(candidate, member),
    );
  });
}

function policyContainsMember(stdout, member) {
  return policyMembers(stdout, member).length > 0;
}

function repositoryPolicyArgs(contract) {
  return [
    "artifacts",
    "repositories",
    "get-iam-policy",
    contract.artifactRepository,
    "--project",
    contract.project,
    "--location",
    contract.region,
    "--format=json",
  ];
}

function removeRepositoryBindingArgs(contract, member) {
  return [
    "artifacts",
    "repositories",
    "remove-iam-policy-binding",
    contract.artifactRepository,
    "--project",
    contract.project,
    "--location",
    contract.region,
    "--member",
    member,
    "--role",
    contract.recoveryRole,
    "--condition=None",
    "--quiet",
  ];
}

/**
 * Reconcile only exact residual fixed-role recovery principals discovered from
 * one authoritative policy read. Returns false if any read or removal fails.
 */
async function reconcileRepositoryBinding({
  contract,
  gcloudBin,
  member,
  runCommand,
}) {
  try {
    const policy = await runCommand(repositoryPolicyArgs(contract), gcloudBin);
    const residualMembers = policyMembers(
      policy,
      member,
      contract.recoveryRole,
      true,
    );
    let clean = true;
    for (const residualMember of residualMembers) {
      try {
        await runCommand(
          removeRepositoryBindingArgs(contract, residualMember),
          gcloudBin,
        );
      } catch {
        clean = false;
      }
    }
    return clean;
  } catch {
    return false;
  }
}

/**
 * Remove every temporary OVD-410 recovery resource independently, then prove
 * absence with successful list/policy readbacks. Mutation failures never skip
 * later compensation; only the final fixed-contract state decides success.
 */
export async function teardownRecoveryHost({
  env = process.env,
  runCommand = defaultRunCommand,
  output = process.stdout,
} = {}) {
  const contract = OVD410_RECOVERY_HOST_CONTRACT;
  const restorationMode = iapRestorationMode(env);
  if (
    env.GOOGLE_CLOUD_PROJECT !== contract.project ||
    restorationMode === null
  ) {
    output.write(
      "OVD-410 recovery teardown configuration is invalid; failing closed.\n",
    );
    return 1;
  }

  const gcloudBin = env.GCLOUD_BIN ?? "gcloud";
  const member = recoveryMember(contract);
  const cleanupSteps = [
    [
      "vm",
      [
        "compute",
        "instances",
        "delete",
        contract.instance,
        "--project",
        contract.project,
        "--zone",
        contract.zone,
        "--quiet",
      ],
    ],
    [
      "firewall",
      [
        "compute",
        "firewall-rules",
        "delete",
        contract.firewallRule,
        "--project",
        contract.project,
        "--quiet",
      ],
    ],
    [
      "repository-binding",
      removeRepositoryBindingArgs(contract, member),
    ],
    [
      "recovery-service-account",
      [
        "iam",
        "service-accounts",
        "delete",
        contract.recoveryServiceAccount,
        "--project",
        contract.project,
        "--quiet",
      ],
    ],
  ];
  if (restorationMode === "disable") {
    cleanupSteps.push([
      "iap-restoration",
      [
        "services",
        "disable",
        contract.iapService,
        "--project",
        contract.project,
        "--quiet",
      ],
    ]);
  }

  const cleanupFailures = [];
  for (const [name, args] of cleanupSteps) {
    try {
      await runCommand(args, gcloudBin);
    } catch {
      cleanupFailures.push(name);
    }
  }

  // A failed binding removal followed by service-account deletion can rewrite
  // the principal as deleted:serviceAccount:...?uid=.... Discover that exact
  // fixed-role tombstone and compensate it before the final readbacks.
  const repositoryBindingReconciled = await reconcileRepositoryBinding({
    contract,
    gcloudBin,
    member,
    runCommand,
  });
  if (!repositoryBindingReconciled) {
    cleanupFailures.push("repository-binding-reconciliation");
  }

  const readbacks = [
    [
      "vm",
      [
        "compute",
        "instances",
        "list",
        "--project",
        contract.project,
        "--zones",
        contract.zone,
        `--filter=name=${contract.instance}`,
        "--format=value(name)",
      ],
      (stdout) => stdout.trim() === "",
    ],
    [
      "firewall",
      [
        "compute",
        "firewall-rules",
        "list",
        "--project",
        contract.project,
        `--filter=name=${contract.firewallRule}`,
        "--format=value(name)",
      ],
      (stdout) => stdout.trim() === "",
    ],
    [
      "repository-binding",
      repositoryPolicyArgs(contract),
      (stdout) => !policyContainsMember(stdout, member),
    ],
    [
      "recovery-service-account",
      [
        "iam",
        "service-accounts",
        "list",
        "--project",
        contract.project,
        `--filter=email=${contract.recoveryServiceAccount}`,
        "--format=value(email)",
      ],
      (stdout) => stdout.trim() === "",
    ],
    [
      "iap-restoration",
      [
        "services",
        "list",
        "--enabled",
        "--project",
        contract.project,
        `--filter=config.name=${contract.iapService}`,
        "--format=value(config.name)",
      ],
      (stdout) =>
        restorationMode === "disable"
          ? stdout.trim() === ""
          : stdout.trim() === contract.iapService,
    ],
  ];

  const residue = [];
  const readbackFailures = [];
  for (const [name, args, isClean] of readbacks) {
    try {
      const stdout = await runCommand(args, gcloudBin);
      if (!isClean(stdout)) residue.push(name);
    } catch {
      readbackFailures.push(name);
    }
  }

  if (residue.length > 0 || readbackFailures.length > 0) {
    output.write(
      `OVD-410 recovery teardown failed closed; residue=${residue.join(",") || "none"}; readback-failures=${readbackFailures.join(",") || "none"}.\n`,
    );
    return 1;
  }

  if (restorationMode === "preserve-enabled") {
    output.write(
      "OVD-410 recovery resources are absent; IAP remains enabled by policy.\n",
    );
  } else {
    output.write(
      "OVD-410 recovery resources are absent and IAP is restored disabled.\n",
    );
  }
  if (cleanupFailures.length > 0) {
    output.write(
      `Compensation commands reported nonzero but final readbacks are clean: ${cleanupFailures.join(",")}.\n`,
    );
  }
  return 0;
}

export async function runCli(options = {}) {
  if ((options.args ?? process.argv.slice(2)).length !== 0) {
    (options.output ?? process.stdout).write(
      "OVD-410 recovery teardown arguments are invalid; failing closed.\n",
    );
    return 1;
  }
  return teardownRecoveryHost(options);
}

if (isDirectCli(import.meta.url)) process.exitCode = await runCli();
