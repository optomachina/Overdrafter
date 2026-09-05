import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const PREREQUISITES = "Quote integration requires this repository's deliberately prepared local Supabase test stack and seed data. Start it with npm run db:start; reset only a disposable stack, then run npm run seed:dev.";

function fail(reason) {
  throw new Error(`${PREREQUISITES} ${reason}`);
}

function isLocalDockerEndpoint(endpoint) {
  return typeof endpoint === "string" && (
    /^unix:\/\/\/[^\s]+$/.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[^/\s]+$/.test(endpoint)
  );
}

function requireLocalDockerDaemon(repoRoot, env, run) {
  // Reject even a shadowed remote host: Supabase and Docker must never disagree
  // about whether an inherited endpoint is safe to use.
  if (env.DOCKER_HOST && !isLocalDockerEndpoint(env.DOCKER_HOST)) {
    fail("DOCKER_HOST must identify a local Docker socket; unset the remote override.");
  }
  // Docker's selected context overrides DOCKER_HOST. Without a context override,
  // an explicit local host takes precedence over the saved current context.
  if (!env.DOCKER_CONTEXT && env.DOCKER_HOST) return;
  const args = ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"];
  if (env.DOCKER_CONTEXT) args.push(env.DOCKER_CONTEXT);
  let endpoint;
  try {
    endpoint = run("docker", args, {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
  } catch {
    fail("Cannot resolve the selected Docker context locally.");
  }
  if (!isLocalDockerEndpoint(endpoint.trim())) {
    fail("The selected Docker context must identify a local Docker socket.");
  }
}

function readProject(config) {
  const rootSection = config.split(/^\s*\[/m)[0];
  const declarations = rootSection.match(/^\s*project_id\s*=.*$/gm) ?? [];
  const match = declarations[0]?.match(/^\s*project_id\s*=\s*"([A-Za-z0-9][A-Za-z0-9_-]{0,62})"\s*(?:#.*)?$/);
  if (declarations.length !== 1 || !match) {
    fail("supabase/config.toml must declare one valid project_id.");
  }
  return match[1];
}

function parseStatus(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)="([^"\r\n]*)"$/);
    if (!match || Object.hasOwn(values, match[1])) {
      fail("Local status output is malformed or contains duplicate fields.");
    }
    values[match[1]] = match[2];
  }
  for (const key of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"]) {
    if (!values[key] || /\s/.test(values[key])) {
      fail(`Local status is missing a valid ${key}.`);
    }
  }
  let url;
  try {
    url = new URL(values.API_URL);
  } catch {
    fail("Local API_URL is malformed.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    fail("Local API_URL must be an HTTP loopback origin with an explicit port.");
  }
  return values;
}

/**
 * Resolve one fail-closed local target before creating clients or running SQL.
 * CLI status and the exact database container are bound to the same config;
 * environment aliases may confirm these values but cannot override them.
 * Command/config dependencies are injectable for offline safety tests.
 */
export function resolveLocalQuoteTestTarget({
  repoRoot,
  env = process.env,
  run = execFileSync,
  readConfig = readFileSync,
}) {
  let config;
  try {
    config = readConfig(path.join(repoRoot, "supabase", "config.toml"), "utf8");
  } catch {
    fail("Cannot read supabase/config.toml.");
  }
  const projectId = readProject(config);
  requireLocalDockerDaemon(repoRoot, env, run);
  let output;
  try {
    output = run("supabase", ["status", "-o", "env", "--workdir", repoRoot], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
  } catch {
    // Do not propagate command output: local status can contain credentials.
    fail("Unable to obtain local Supabase status.");
  }
  const status = parseStatus(output);
  const aliases = {
    SUPABASE_URL: "API_URL", API_URL: "API_URL",
    SUPABASE_ANON_KEY: "ANON_KEY", ANON_KEY: "ANON_KEY",
    SUPABASE_SERVICE_ROLE_KEY: "SERVICE_ROLE_KEY", SERVICE_ROLE_KEY: "SERVICE_ROLE_KEY",
  };
  for (const [alias, key] of Object.entries(aliases)) {
    if (env[alias] !== undefined && env[alias] !== status[key]) {
      fail(`${alias} conflicts with this repository's local status; unset the override.`);
    }
  }
  const containerName = `supabase_db_${projectId}`;
  let container;
  try {
    container = run("docker", ["inspect", "--type", "container", "--format", "{{.Name}} {{.State.Running}}", containerName], {
      cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
  } catch {
    fail("The repository's exact local database container is unavailable.");
  }
  if (container.trim() !== `/${containerName} true`) {
    fail("The repository's exact local database container is not running.");
  }
  return Object.freeze({
    supabaseUrl: status.API_URL,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    anonKey: status.ANON_KEY,
    containerName,
  });
}
