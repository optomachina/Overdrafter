import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OVD373_PRODUCTION_DATABASE_USERS,
  OVD373_PRODUCTION_PROJECT_REF,
  validateDatabaseTarget,
} from "./verify-ovd373-database-target.mjs";
import {
  CREDENTIAL_TTL_SECONDS,
  assertRemaining,
  buildPgpassEntry,
  buildTemporaryPoolerUrl,
  grant,
  getTemporaryPgpassPath,
  getTemporaryStatePath,
  normalizeKeychainToken,
  requestManagementApi,
  revoke,
  restorePermanentPoolerUrl,
  validateLoginRoleResponse,
  validateTemporaryState,
} from "./manage-ovd373-temporary-db-access.mjs";

const PERMANENT_URL =
  `postgresql://${OVD373_PRODUCTION_DATABASE_USERS[0]}`
  + "@aws-1-us-west-1.pooler.supabase.com:5432/postgres";
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeAccessFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ovd373-access-"));
  temporaryDirectories.push(fixtureRoot);
  const paths = {
    projectRefPath: path.join(fixtureRoot, "project-ref"),
    poolerPath: path.join(fixtureRoot, "pooler-url"),
    pgpassPath: path.join(fixtureRoot, "production.pgpass"),
    statePath: path.join(fixtureRoot, "production.pgpass.state.json"),
  };
  await writeFile(paths.projectRefPath, `${OVD373_PRODUCTION_PROJECT_REF}\n`, { mode: 0o600 });
  await writeFile(paths.poolerPath, `${PERMANENT_URL}\n`, { mode: 0o600 });
  return { fixtureRoot, paths };
}

function makeRequestApi(events) {
  return async (method) => {
    events.push(method);
    if (method === "DELETE") return undefined;
    return {
      role: "cli_login_postgres",
      password: "a-secure-temporary-password",
      ttl_seconds: CREDENTIAL_TTL_SECONDS,
    };
  };
}

describe("OVD-373 temporary database access", () => {
  it("normalizes both native and Go-keyring token storage", () => {
    expect(normalizeKeychainToken("sbp_example\n")).toBe("sbp_example");
    expect(normalizeKeychainToken(`go-keyring-base64:${Buffer.from("sbp_example").toString("base64")}`))
      .toBe("sbp_example");
  });

  it("uses one fixed external pgpass path", () => {
    expect(path.isAbsolute(getTemporaryPgpassPath())).toBe(true);
    expect(path.basename(getTemporaryPgpassPath()))
      .toBe(`overdrafter-${OVD373_PRODUCTION_PROJECT_REF}-production.pgpass`);
    expect(getTemporaryStatePath()).toBe(`${getTemporaryPgpassPath()}.state.json`);
  });

  it("accepts only the exact Supabase temporary-role response", () => {
    const response = {
      role: "cli_login_postgres",
      password: "a-secure-temporary-password",
      ttl_seconds: 3600,
    };
    expect(validateLoginRoleResponse(response)).toBe(response);
    expect(() => validateLoginRoleResponse({ ...response, role: "postgres" })).toThrow("unexpected");
    expect(() => validateLoginRoleResponse({ ...response, ttl_seconds: 3599 })).toThrow("lifetime");
    expect(() => validateLoginRoleResponse({ ...response, ttl_seconds: 3601 })).toThrow("lifetime");
    expect(() => validateLoginRoleResponse({ ...response, password: "short" })).toThrow("invalid");
  });

  it("rewrites only the exact permanent role and remains project-bound", () => {
    const temporaryUrl = buildTemporaryPoolerUrl(PERMANENT_URL);
    expect(decodeURIComponent(new URL(temporaryUrl).username))
      .toBe(OVD373_PRODUCTION_DATABASE_USERS[1]);
    expect(validateDatabaseTarget({
      projectRef: OVD373_PRODUCTION_PROJECT_REF,
      poolerUrl: temporaryUrl,
    })).toEqual([]);
    expect(restorePermanentPoolerUrl(temporaryUrl)).toBe(new URL(PERMANENT_URL).toString());
  });

  it.each([
    PERMANENT_URL.replace(OVD373_PRODUCTION_PROJECT_REF, "attacker"),
    PERMANENT_URL.replace("postgres.", "cli_login_other."),
    PERMANENT_URL.replace("postgres.", "cli_login_postgres."),
  ])("rejects an unapproved source role: %s", (candidate) => {
    expect(() => buildTemporaryPoolerUrl(candidate)).toThrow();
  });

  it("escapes pgpass fields and never embeds credentials in the URL", () => {
    const temporaryUrl = buildTemporaryPoolerUrl(PERMANENT_URL);
    const pgpass = buildPgpassEntry(temporaryUrl, String.raw`secret:with\\slashes`);
    expect(pgpass).toBe(
      String.raw`aws-1-us-west-1.pooler.supabase.com:5432:postgres:${OVD373_PRODUCTION_DATABASE_USERS[1]}:secret\:with\\\\slashes` + "\n",
    );
    expect(temporaryUrl).not.toContain("secret");
  });

  it("requires exact Management API success statuses and revocation body", async () => {
    const fetchImpl = async (_url, options) => {
      if (options.method === "POST") {
        return new Response(JSON.stringify({
          role: "cli_login_postgres",
          password: "a-secure-temporary-password",
          ttl_seconds: CREDENTIAL_TTL_SECONDS,
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await expect(requestManagementApi("POST", "sbp_example", { read_only: false }, fetchImpl))
      .resolves.toMatchObject({ role: "cli_login_postgres" });
    await expect(requestManagementApi("DELETE", "sbp_example", undefined, fetchImpl))
      .resolves.toBeUndefined();

    const acceptedButUnconfirmed = async () => new Response("", { status: 202 });
    await expect(requestManagementApi("DELETE", "sbp_example", undefined, acceptedButUnconfirmed))
      .rejects.toThrow("status 202");
    const wrongBody = async () => new Response(JSON.stringify({ message: "pending" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(requestManagementApi("DELETE", "sbp_example", undefined, wrongBody))
      .rejects.toThrow("unexpected response");
  });

  it("pins exact one-hour expiry evidence and reports elapsed lifetime", () => {
    const now = Date.parse("2026-08-16T08:00:00.000Z");
    const state = {
      version: "ovd373-temporary-db-access.v1",
      projectRef: OVD373_PRODUCTION_PROJECT_REF,
      role: "cli_login_postgres",
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CREDENTIAL_TTL_SECONDS * 1000).toISOString(),
    };
    expect(validateTemporaryState(state, now + 15 * 60 * 1000)).toBe(45 * 60);
    expect(validateTemporaryState(state, now + CREDENTIAL_TTL_SECONDS * 1000)).toBe(0);
    expect(() => validateTemporaryState({
      ...state,
      expiresAt: new Date(now + (CREDENTIAL_TTL_SECONDS + 1) * 1000).toISOString(),
    }, now)).toThrow("lifetime evidence");
  });

  it("grants and idempotently revokes one project-bound temporary credential", async () => {
    const { paths } = await makeAccessFixture();
    const events = [];
    const requestApi = makeRequestApi(events);
    const now = Date.parse("2026-08-16T08:00:00.000Z");
    await grant({ paths, accessToken: "sbp_example", requestApi, now });

    expect(events).toEqual(["POST"]);
    expect(decodeURIComponent(new URL(await readFile(paths.poolerPath, "utf8")).username))
      .toBe(OVD373_PRODUCTION_DATABASE_USERS[1]);
    expect(await readFile(paths.pgpassPath, "utf8")).toContain(OVD373_PRODUCTION_DATABASE_USERS[1]);
    expect(validateTemporaryState(JSON.parse(await readFile(paths.statePath, "utf8")), now))
      .toBe(CREDENTIAL_TTL_SECONDS);
    await expect(assertRemaining(45 * 60, { paths, now: now + 15 * 60 * 1000 }))
      .resolves.toBeUndefined();
    await expect(assertRemaining(45 * 60, { paths, now: now + 16 * 60 * 1000 }))
      .rejects.toThrow("seconds remaining");

    await revoke({ paths, accessToken: "sbp_example", requestApi });
    await revoke({ paths, accessToken: "sbp_example", requestApi });
    expect(events).toEqual(["POST", "DELETE", "DELETE"]);
    expect(decodeURIComponent(new URL(await readFile(paths.poolerPath, "utf8")).username))
      .toBe(OVD373_PRODUCTION_DATABASE_USERS[0]);
    await expect(access(paths.pgpassPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revokes server access before attempting fallible local rollback", async () => {
    const { paths } = await makeAccessFixture();
    const events = [];
    const requestApi = makeRequestApi(events);
    const rmImpl = async () => {
      events.push("rm");
      throw new Error("simulated local cleanup failure");
    };
    const replacePoolerUrlImpl = async () => {
      throw new Error("simulated pooler rewrite failure");
    };

    await expect(grant({
      paths,
      accessToken: "sbp_example",
      requestApi,
      rmImpl,
      replacePoolerUrlImpl,
    })).rejects.toThrow("cleanup was incomplete");
    expect(events).toEqual(["POST", "DELETE", "rm", "rm"]);
  });

  it("revokes server access before inspecting fallible local cleanup paths", async () => {
    const { paths } = await makeAccessFixture();
    const events = [];
    const requestApi = makeRequestApi(events);
    await rm(paths.poolerPath);

    await expect(revoke({ paths, accessToken: "sbp_example", requestApi }))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(events).toEqual(["DELETE"]);
  });
});
