#!/usr/bin/env node
// OVD-722 provider kill switch CLI.
//
//   npm run provider:kill -- <provider>|--all --on|--off --reason "..." [--yes]
//   npm run provider:kill -- --list
//
// Calls the platform-admin RPCs with the admin's OWN Supabase session:
//   SUPABASE_URL                      project URL
//   SUPABASE_PUBLISHABLE_KEY          anon/publishable key (VITE_SUPABASE_PUBLISHABLE_KEY also accepted)
//   OVERDRAFTER_ADMIN_ACCESS_TOKEN    the signed-in admin's access token (JWT)
//
// The service role is never used: a service_role key or token is refused, and
// SUPABASE_SERVICE_ROLE_KEY is never read. The database enforces the
// platform-admin check, the >= 10 character reason, and the audit row.
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

export const MIN_REASON_LENGTH = 10;

export class ProviderKillUsageError extends Error {}

const USAGE = 'usage: provider:kill -- <provider>|--all --on|--off --reason "<at least 10 characters>" [--yes]\n'
  + "       provider:kill -- --list";

export function parseProviderKillArgs(argv) {
  const parsed = { target: null, engaged: null, reason: null, yes: false, list: false };
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
    if (parsed.target || parsed.engaged !== null || parsed.reason !== null) {
      throw new ProviderKillUsageError(`--list takes no other options.\n${USAGE}`);
    }
    return { list: true };
  }
  if (!parsed.target) throw new ProviderKillUsageError(`Pass a provider key or --all.\n${USAGE}`);
  if (parsed.engaged === null) throw new ProviderKillUsageError(`Pass --on or --off.\n${USAGE}`);
  const reason = (parsed.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new ProviderKillUsageError(`--reason is required and must be at least ${MIN_REASON_LENGTH} characters.`);
  }
  return { list: false, target: parsed.target, engaged: parsed.engaged, reason, yes: parsed.yes };
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

export function resolveAdminSession(env) {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const apiKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const accessToken = env.OVERDRAFTER_ADMIN_ACCESS_TOKEN;
  if (!url || !apiKey || !accessToken) {
    throw new ProviderKillUsageError(
      "Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and OVERDRAFTER_ADMIN_ACCESS_TOKEN (your own signed-in admin session).",
    );
  }
  // Never the service role: the switch must be flipped by an accountable admin.
  if (jwtRole(apiKey) === "service_role" || jwtRole(accessToken) === "service_role"
    || (env.SUPABASE_SERVICE_ROLE_KEY && (apiKey === env.SUPABASE_SERVICE_ROLE_KEY || accessToken === env.SUPABASE_SERVICE_ROLE_KEY))) {
    throw new ProviderKillUsageError("Refusing to use a service_role credential; sign in as a platform admin.");
  }
  if (jwtRole(accessToken) !== "authenticated") {
    throw new ProviderKillUsageError("OVERDRAFTER_ADMIN_ACCESS_TOKEN must be an authenticated user session token.");
  }
  return { url: url.replace(/\/+$/, ""), apiKey, accessToken };
}

export function buildProviderKillRequest(command) {
  if (command.list) return { rpc: "api_admin_list_provider_kill_switches", body: {} };
  if (command.target.kind === "global") {
    return { rpc: "api_admin_set_global_kill_switch", body: { p_engaged: command.engaged, p_reason: command.reason } };
  }
  return {
    rpc: "api_admin_set_provider_kill_switch",
    body: { p_provider: command.target.provider, p_engaged: command.engaged, p_reason: command.reason },
  };
}

export function describeProviderKillCommand(command) {
  const scope = command.target.kind === "global" ? "ALL providers (global switch)" : `provider ${command.target.provider}`;
  return `${command.engaged ? "ENGAGE (stop all automated traffic to)" : "RELEASE"} ${scope}\nreason: ${command.reason}`;
}

async function defaultConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function runProviderKill(argv, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  confirm = defaultConfirm,
  log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const command = parseProviderKillArgs(argv);
  const session = resolveAdminSession(env);
  if (!command.list && !command.yes) {
    log(describeProviderKillCommand(command));
    const expected = command.target.kind === "global" ? "all" : command.target.provider;
    const typed = await confirm(`Type "${expected}" to confirm: `);
    if (typed !== expected) {
      log("Not confirmed; nothing changed.");
      return { changed: false };
    }
  }
  const request = buildProviderKillRequest(command);
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
    throw new Error(`${request.rpc} failed (${response.status}): ${message}`);
  }
  const data = text ? JSON.parse(text) : null;
  log(JSON.stringify(data, null, 2));
  return { changed: !command.list, data };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runProviderKill(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof ProviderKillUsageError ? 2 : 1;
  });
}
