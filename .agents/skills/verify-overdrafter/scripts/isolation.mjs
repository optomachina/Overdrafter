#!/usr/bin/env node
// Local-only isolation check: every Supabase/app target in the environment must
// be unset or point at 127.0.0.1/localhost. Prints variable names only, never values.
// Exits 0 when isolated, 1 otherwise.
import { fileURLToPath } from "node:url";

export const URL_VARS = [
  "VITE_SUPABASE_URL",
  "PLAYWRIGHT_BASE_URL",
  "SUPABASE_URL",
  "API_URL",
  "SUPABASE_DB_URL",
  "DB_URL",
];

export const KEY_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLocalUrl(value) {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

// A key "points at" a project through its JWT claims. Only the Supabase CLI's
// local demo JWTs (iss "supabase-demo", no project ref) count as local; opaque
// or hosted keys fail closed.
export function isLocalKey(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims.iss === "supabase-demo" && claims.ref === undefined;
  } catch {
    return false;
  }
}

export function isolationProblems(env) {
  const bad = [];
  for (const name of URL_VARS) if (env[name] && !isLocalUrl(env[name])) bad.push(name);
  for (const name of KEY_VARS) if (env[name] && !isLocalKey(env[name])) bad.push(name);
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = isolationProblems(process.env);
  for (const name of bad) console.log(`FAIL ${name} is set to a non-local target; unset it or point it at 127.0.0.1`);
  process.exit(bad.length === 0 ? 0 : 1);
}
