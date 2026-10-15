#!/usr/bin/env node
// OVD-722 provider kill switch CLI; OVD-771 moved it to the service role.
//
//   npm run provider:kill -- <provider>|--all --on|--off --reason "..." --operator "<name>" [--yes]
//   npm run provider:kill -- --list
//
// This is the emergency brake, so it must never depend on an admin completing
// MFA (the admin UI requires an AAL2 session). It calls the service_role-only
// RPCs (docs/migration-drafts/ovd-771.sql):
//   SUPABASE_URL                project URL (VITE_SUPABASE_URL also accepted)
//   SUPABASE_SERVICE_ROLE_KEY   service role secret (sb_secret_... or a legacy service_role JWT)
// or, by name only, a GCP Secret Manager secret read with
// `gcloud secrets versions access latest` (takes precedence when given):
//   --secret-name / OVERDRAFTER_SERVICE_ROLE_SECRET_NAME
//   --secret-project / OVERDRAFTER_SERVICE_ROLE_SECRET_PROJECT (optional; gcloud default otherwise)
// The key is never logged and is redacted from every output and error line.
//
// The database records the audit row with actor 'cli:service_role' and the
// required --operator name (who is pulling the brake), plus the reason. It
// enforces the >= 10 character reason, the operator, and the
// service_role-only grant; the CLI cannot choose the actor.
//
// --on never needs a version: an emergency stop always wins. --off first reads
// the current row, shows it in the confirmation, and sends that row's version;
// the database refuses the release (kill_switch_version_conflict) if anyone
// flipped the switch after that read.
import { execFile } from "node:child_process";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MIN_REASON_LENGTH = 10;
export const MIN_OPERATOR_LENGTH = 2;
export const MAX_OPERATOR_LENGTH = 120;

export class ProviderKillUsageError extends Error {}

const USAGE = 'usage: provider:kill -- <provider>|--all --on|--off --reason "<at least 10 characters>" --operator "<your name>" [--yes]\n'
  + "       provider:kill -- --list\n"
  + "       key: SUPABASE_SERVICE_ROLE_KEY, or [--secret-name <GCP secret>] [--secret-project <GCP project>]";

export function parseProviderKillArgs(argv) {
  const parsed = {
    target: null, engaged: null, reason: null, operator: null, yes: false, list: false, secretName: null, secretProject: null,
  };
  const optionValue = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ProviderKillUsageError(`${name} needs a value.\n${USAGE}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--on" || arg === "--off") {
      if (parsed.engaged !== null) throw new ProviderKillUsageError(`Pass exactly one of --on or --off.\n${USAGE}`);
      parsed.engaged = arg === "--on";
    } else if (arg === "--all") {
      if (parsed.target !== null) throw new ProviderKillUsageError(`Pass exactly one provider or --all.\n${USAGE}`);
      parsed.target = { kind: "global" };
    } else if (arg === "--reason") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ProviderKillUsageError(`--reason needs a value.\n${USAGE}`);
      parsed.reason = value;
      index += 1;
    } else if (arg.startsWith("--reason=")) {
      parsed.reason = arg.slice("--reason=".length);
    } else if (arg === "--operator") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ProviderKillUsageError(`--operator needs a value.\n${USAGE}`);
      parsed.operator = value;
      index += 1;
    } else if (arg.startsWith("--operator=")) {
      parsed.operator = arg.slice("--operator=".length);
    } else if (arg === "--secret-name" || arg === "--secret-project") {
      parsed[arg === "--secret-name" ? "secretName" : "secretProject"] = optionValue(arg, index);
      index += 1;
    } else if (arg.startsWith("--secret-name=")) {
      parsed.secretName = arg.slice("--secret-name=".length);
    } else if (arg.startsWith("--secret-project=")) {
      parsed.secretProject = arg.slice("--secret-project=".length);
    } else if (arg === "--yes") {
      parsed.yes = true;
    } else if (arg === "--list") {
      parsed.list = true;
    } else if (arg.startsWith("--")) {
      throw new ProviderKillUsageError(`Unknown option ${arg}.\n${USAGE}`);
    } else {
      if (parsed.target !== null) throw new ProviderKillUsageError(`Pass exactly one provider or --all.\n${USAGE}`);
      if (!/^[a-z][a-z0-9_]*$/.test(arg)) throw new ProviderKillUsageError(`Invalid provider key ${JSON.stringify(arg)}.`);
      parsed.target = { kind: "provider", provider: arg };
    }
  }

  if (parsed.list) {
    if (parsed.target || parsed.engaged !== null || parsed.reason !== null || parsed.operator !== null) {
      throw new ProviderKillUsageError(`--list takes no flip options.\n${USAGE}`);
    }
    return { list: true, secretName: parsed.secretName, secretProject: parsed.secretProject };
  }
  if (!parsed.target) throw new ProviderKillUsageError(`Pass a provider key or --all.\n${USAGE}`);
  if (parsed.engaged === null) throw new ProviderKillUsageError(`Pass --on or --off.\n${USAGE}`);
  const reason = (parsed.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new ProviderKillUsageError(`--reason is required and must be at least ${MIN_REASON_LENGTH} characters.`);
  }
  const operator = (parsed.operator ?? "").trim();
  if (operator.length < MIN_OPERATOR_LENGTH || operator.length > MAX_OPERATOR_LENGTH || /\p{Cc}/u.test(operator)) {
    throw new ProviderKillUsageError(
      `--operator is required (${MIN_OPERATOR_LENGTH}-${MAX_OPERATOR_LENGTH} printable characters): who is pulling the brake.`,
    );
  }
  return {
    list: false,
    target: parsed.target,
    engaged: parsed.engaged,
    reason,
    operator,
    yes: parsed.yes,
    secretName: parsed.secretName,
    secretProject: parsed.secretProject,
  };
}

function jwtRole(token) {
  const [, payload] = String(token).split(".");
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof decoded?.role === "string" ? decoded.role : null;
  } catch {
    return null;
  }
}

const SECRET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REDACTED = "[REDACTED]";

/** Replaces every occurrence of the key in text; output and errors pass through this. */
export function redactSecret(text, secret) {
  const value = String(text);
  return secret ? value.split(secret).join(REDACTED) : value;
}

function redactError(error, secret) {
  const message = redactSecret(error instanceof Error ? error.message : String(error), secret);
  return error instanceof ProviderKillUsageError ? new ProviderKillUsageError(message) : new Error(message);
}

/** Same access pattern as scripts/ovd419-diagnostic-adapter.mjs: gcloud, by secret name, stdout only. */
async function defaultReadSecret(name, project) {
  const args = ["secrets", "versions", "access", "latest", `--secret=${name}`];
  if (project) args.push("--project", project);
  const { stdout } = await execFileAsync("gcloud", args, { encoding: "utf8", maxBuffer: 64 * 1024 });
  return stdout;
}

/**
 * The service role key, by name only: a Secret Manager secret name
 * (--secret-name or OVERDRAFTER_SERVICE_ROLE_SECRET_NAME) wins when given,
 * otherwise SUPABASE_SERVICE_ROLE_KEY. The value is never logged.
 */
export async function resolveServiceKey(command, env, readSecret = defaultReadSecret) {
  const secretName = command.secretName ?? env.OVERDRAFTER_SERVICE_ROLE_SECRET_NAME;
  if (secretName) {
    const project = command.secretProject ?? env.OVERDRAFTER_SERVICE_ROLE_SECRET_PROJECT ?? null;
    if (!SECRET_NAME_PATTERN.test(secretName)) throw new ProviderKillUsageError("Invalid Secret Manager secret name.");
    if (project !== null && !GCP_PROJECT_PATTERN.test(project)) throw new ProviderKillUsageError("Invalid GCP project id.");
    let value;
    try {
      value = await readSecret(secretName, project);
    } catch {
      // gcloud's own error output is dropped: it is not needed and is never echoed.
      throw new Error(
        `Could not read Secret Manager secret ${secretName} (gcloud secrets versions access latest); `
          + "check gcloud auth, the project, and the secret name. Nothing changed.",
      );
    }
    const key = String(value ?? "").trim();
    if (!key || /[\r\n]/.test(key)) throw new Error(`Secret Manager secret ${secretName} is empty or malformed. Nothing changed.`);
    return key;
  }
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY;
  throw new ProviderKillUsageError(
    "No service role key. Set SUPABASE_SERVICE_ROLE_KEY, or pass --secret-name <GCP Secret Manager secret name> "
      + "(or set OVERDRAFTER_SERVICE_ROLE_SECRET_NAME). Nothing changed.",
  );
}

export function resolveServiceSession(env, serviceKey) {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  if (!url) {
    throw new ProviderKillUsageError("Set SUPABASE_URL (the project URL). Nothing changed.");
  }
  // A publishable key or a user session in the wrong variable would only be
  // refused by the database; say why before anything reaches the network.
  const role = jwtRole(serviceKey);
  const isServiceSecret = role === null ? /^sb_secret_[A-Za-z0-9_-]+$/.test(serviceKey) : role === "service_role";
  if (!isServiceSecret) {
    throw new ProviderKillUsageError(
      "The service role key is not a service role secret (expected sb_secret_... or a service_role JWT). Nothing changed.",
    );
  }
  return { url: url.replace(/\/+$/, ""), apiKey: serviceKey, accessToken: serviceKey };
}

const LIST_RPC = "api_service_list_provider_kill_switches";

export function buildProviderKillRequest(command, expectedVersion = null) {
  if (command.list) return { rpc: LIST_RPC, body: {} };
  const versionArg = command.engaged ? {} : { p_expected_version: expectedVersion };
  if (command.target.kind === "global") {
    return {
      rpc: "api_service_set_global_kill_switch",
      body: { p_engaged: command.engaged, p_reason: command.reason, p_operator: command.operator, ...versionArg },
    };
  }
  return {
    rpc: "api_service_set_provider_kill_switch",
    body: {
      p_provider: command.target.provider,
      p_engaged: command.engaged,
      p_reason: command.reason,
      p_operator: command.operator,
      ...versionArg,
    },
  };
}

/** The row a release is decided on, from the service list RPC payload. */
export function currentSwitchRow(listData, target) {
  const row = target.kind === "global"
    ? listData?.global
    : (Array.isArray(listData?.providers) ? listData.providers : []).find((entry) => entry?.provider === target.provider);
  if (!row || typeof row !== "object" || !Number.isSafeInteger(row.version) || row.version < 0) {
    throw new Error("Could not read the current switch state and version; nothing changed.");
  }
  return row;
}

export function describeProviderKillCommand(command) {
  const scope = command.target.kind === "global" ? "ALL providers (global switch)" : `provider ${command.target.provider}`;
  return `${command.engaged ? "ENGAGE (stop all automated traffic to)" : "RELEASE"} ${scope}\nreason: ${command.reason}\noperator: ${command.operator}`;
}

async function defaultConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function callRpc(session, fetchImpl, request) {
  const response = await fetchImpl(`${session.url}/rest/v1/rpc/${request.rpc}`, {
    method: "POST",
    headers: {
      apikey: session.apiKey,
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = JSON.parse(text)?.message ?? text;
    } catch {
      // keep raw text
    }
    if (String(message).includes("kill_switch_version_conflict")) {
      message = "the switch changed after it was read (kill_switch_version_conflict); run --list and retry if still intended";
    } else if (response.status === 404) {
      message = `${message} (is the OVD-771 service kill switch migration applied? Until it is, use the admin UI)`;
    }
    throw new Error(`${request.rpc} failed (${response.status}): ${message}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function runProviderKill(argv, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  confirm = defaultConfirm,
  readSecret = defaultReadSecret,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const command = parseProviderKillArgs(argv);
  const key = await resolveServiceKey(command, env, readSecret);
  try {
    return await runWithKey(command, resolveServiceSession(env, key), {
      fetchImpl, confirm, log: (line) => log(redactSecret(line, key)),
    });
  } catch (error) {
    throw redactError(error, key);
  }
}

async function runWithKey(command, session, { fetchImpl, confirm, log }) {
  let expectedVersion = null;
  if (!command.list && !command.engaged) {
    const row = currentSwitchRow(await callRpc(session, fetchImpl, buildProviderKillRequest({ list: true })), command.target);
    expectedVersion = row.version;
    log(`current: ${row.engaged ? "ENGAGED" : "released"} since ${row.changedAt ?? "never"} by ${row.operator ?? row.changedBy ?? "unknown"}`
      + ` (version ${row.version})\nlast reason: ${row.reason ?? "none"}`);
  }
  if (!command.list && !command.yes) {
    log(describeProviderKillCommand(command));
    const expected = command.target.kind === "global" ? "all" : command.target.provider;
    const typed = await confirm(`Type "${expected}" to confirm: `);
    if (typed !== expected) {
      log("Not confirmed; nothing changed.");
      return { changed: false };
    }
  }
  const data = await callRpc(session, fetchImpl, buildProviderKillRequest(command, expectedVersion));
  log(JSON.stringify(data, null, 2));
  return { changed: !command.list, data };
}

/** Exit code: 0 done (or not confirmed), 2 usage or configuration error, 1 any other failure. */
export async function main(argv, { stderr = (text) => process.stderr.write(text), ...options } = {}) {
  try {
    await runProviderKill(argv, options);
    return 0;
  } catch (error) {
    // Already redacted by runProviderKill once the key is known.
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ProviderKillUsageError ? 2 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
