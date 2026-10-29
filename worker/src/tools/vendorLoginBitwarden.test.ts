// @vitest-environment node

import process from "node:process";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BitwardenError,
  BitwardenVault,
  childEnv,
  defaultExecFile,
  itemUriMatchesHosts,
  parseLoginItem,
  SecretString,
  type ExecFileRunner,
} from "./vendorLoginBitwarden";

const MASTER = "fixture-master-password-SENTINEL";
const SESSION_KEY = "fixture-session-key-SENTINEL";
const ITEM_PASSWORD = "fixture-vendor-password-SENTINEL";
const ITEM_USERNAME = "fixture-user@example.test";
const QUICKPARTS_HOSTS = ["quickparts.com", "quickquote.quickparts.com"];

function loginItemJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 1,
    name: "fixture item",
    login: { username: ITEM_USERNAME, password: ITEM_PASSWORD, uris: [{ uri: "https://quickquote.quickparts.com/#/login" }] },
    ...overrides,
  });
}

type Call = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv };

function fakeRunner(responses: Record<string, string | BitwardenError>): { run: ExecFileRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: ExecFileRunner = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const key = file === "/usr/bin/security" ? "security" : args[0];
    const response = responses[key];
    if (response instanceof BitwardenError) throw response;
    if (response === undefined) throw new BitwardenError("failed");
    return response;
  };
  return { run, calls };
}

const baseEnv = { PATH: "/usr/bin:/bin", HOME: "/home/fixture", SUPABASE_SERVICE_ROLE_KEY: "service-role-SENTINEL" };

function everyArgument(calls: readonly Call[]): string {
  return calls.flatMap((call) => [call.file, ...call.args]).join(" ");
}

describe("SecretString", () => {
  it("never prints its value through JSON, interpolation, String or inspect", () => {
    const secret = new SecretString(ITEM_PASSWORD);
    const rendered = [JSON.stringify({ secret }), `${secret}`, String(secret), inspect(secret), inspect({ nested: { secret } })];
    for (const text of rendered) expect(text).not.toContain(ITEM_PASSWORD);
    expect(secret.reveal()).toBe(ITEM_PASSWORD);
  });
});

describe("item URI host matching", () => {
  it("accepts reviewed hosts, their parent domain and subdomains", () => {
    expect(itemUriMatchesHosts("https://quickquote.quickparts.com/#/login", QUICKPARTS_HOSTS)).toBe(true);
    expect(itemUriMatchesHosts("quickparts.com", QUICKPARTS_HOSTS)).toBe(true);
    expect(itemUriMatchesHosts("http://www.weerg.com", ["www.weerg.com"])).toBe(true);
    expect(itemUriMatchesHosts("weerg.com", ["www.weerg.com"])).toBe(true);
  });

  it("rejects other sites, bare suffixes, look-alikes and non-web schemes", () => {
    expect(itemUriMatchesHosts("https://accounts.google.com", QUICKPARTS_HOSTS)).toBe(false);
    expect(itemUriMatchesHosts("com", QUICKPARTS_HOSTS)).toBe(false);
    expect(itemUriMatchesHosts("https://quickparts.com.evil.test", QUICKPARTS_HOSTS)).toBe(false);
    expect(itemUriMatchesHosts("https://notquickparts.com", QUICKPARTS_HOSTS)).toBe(false);
    expect(itemUriMatchesHosts("androidapp://com.quickparts", QUICKPARTS_HOSTS)).toBe(false);
    expect(itemUriMatchesHosts("not a uri", QUICKPARTS_HOSTS)).toBe(false);
  });
});

describe("login item parsing", () => {
  it("returns redacted credentials for a login item on a reviewed host", () => {
    const credential = parseLoginItem(loginItemJson(), QUICKPARTS_HOSTS);
    expect(credential.username.reveal()).toBe(ITEM_USERNAME);
    expect(credential.password.reveal()).toBe(ITEM_PASSWORD);
    expect(JSON.stringify(credential)).not.toContain(ITEM_PASSWORD);
  });

  it("refuses an item saved for another site, a non-login item, and unparsable output, without echoing them", () => {
    const failures = [
      () => parseLoginItem(loginItemJson({ login: { username: ITEM_USERNAME, password: ITEM_PASSWORD, uris: [{ uri: "https://mail.example.test" }] } }), QUICKPARTS_HOSTS),
      () => parseLoginItem(loginItemJson({ login: { username: ITEM_USERNAME, password: ITEM_PASSWORD, uris: null } }), QUICKPARTS_HOSTS),
      () => parseLoginItem(loginItemJson({ type: 2 }), QUICKPARTS_HOSTS),
      () => parseLoginItem(`{"login":{"password":"${ITEM_PASSWORD}"`, QUICKPARTS_HOSTS),
    ];
    const codes = failures.map((fail) => {
      try {
        fail();
        return "no error";
      } catch (error) {
        expect(error).toBeInstanceOf(BitwardenError);
        expect(String((error as Error).message)).not.toContain(ITEM_PASSWORD);
        return (error as BitwardenError).code;
      }
    });
    expect(codes).toEqual(["item_uri_mismatch", "item_uri_mismatch", "item_not_a_login", "unexpected_output"]);
  });
});

describe("child process environment", () => {
  it("passes only what the CLIs need, never worker secrets", () => {
    const env = childEnv({ ...baseEnv, OPENAI_API_KEY: "x", BW_SESSION: "outer" }, { BW_SESSION: "inner" });
    expect(env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/fixture", BW_NOINTERACTION: "true", BW_SESSION: "inner" });
  });
});

describe("Bitwarden vault, session-env unlock", () => {
  const config = { cliPath: "/opt/fixture/bw", unlock: "session-env" as const };

  it("requires an exported BW_SESSION and an unlocked vault", async () => {
    await expect(new BitwardenVault(config, baseEnv, fakeRunner({}).run).open())
      .rejects.toMatchObject({ code: "session_env_missing" });
    const locked = fakeRunner({ status: JSON.stringify({ status: "locked" }) });
    await expect(new BitwardenVault(config, { ...baseEnv, BW_SESSION: SESSION_KEY }, locked.run).open())
      .rejects.toMatchObject({ code: "vault_locked" });
  });

  it("keeps the session it was constructed with after the caller drops BW_SESSION", async () => {
    const env: NodeJS.ProcessEnv = { ...baseEnv, BW_SESSION: SESSION_KEY };
    const fake = fakeRunner({ status: JSON.stringify({ status: "unlocked" }), sync: "" });
    const vault = new BitwardenVault(config, env, fake.run);
    delete env.BW_SESSION;
    await vault.open();
    expect(fake.calls[0].env.BW_SESSION).toBe(SESSION_KEY);
  });

  it("reads the item with the session in the environment only, and never locks a vault it did not unlock", async () => {
    const fake = fakeRunner({ status: JSON.stringify({ status: "unlocked" }), sync: "", get: loginItemJson(), lock: "" });
    const vault = new BitwardenVault(config, { ...baseEnv, BW_SESSION: SESSION_KEY }, fake.run);
    await vault.open();
    const credential = await vault.loginItem("fixture-item-id", QUICKPARTS_HOSTS);
    await vault.close();
    expect(credential.password.reveal()).toBe(ITEM_PASSWORD);
    expect(fake.calls.map((call) => call.args)).toEqual([
      ["status", "--nointeraction"],
      ["sync", "--nointeraction"],
      ["get", "item", "fixture-item-id", "--nointeraction"],
    ]);
    for (const call of fake.calls) {
      expect(call.file).toBe("/opt/fixture/bw");
      expect(call.env.BW_SESSION).toBe(SESSION_KEY);
      expect(call.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    }
    expect(everyArgument(fake.calls)).not.toContain(SESSION_KEY);
  });
});

describe("Bitwarden vault, keychain unlock", () => {
  const config = {
    cliPath: "bw",
    unlock: "keychain" as const,
    keychainService: "overdrafter-bitwarden-fixture",
    keychainAccount: "fixture-account",
  };

  it("unlocks with the keychain password through --passwordenv, uses the session key, then locks", async () => {
    const fake = fakeRunner({
      status: JSON.stringify({ status: "locked" }),
      security: `${MASTER}\n`,
      unlock: `${SESSION_KEY}\n`,
      sync: "",
      get: loginItemJson(),
      lock: "",
    });
    const vault = new BitwardenVault(config, baseEnv, fake.run);
    await vault.open();
    await vault.loginItem("fixture-item-id", QUICKPARTS_HOSTS);
    await vault.close();

    expect(fake.calls.map((call) => [call.file, ...call.args])).toEqual([
      ["bw", "status", "--nointeraction"],
      ["/usr/bin/security", "find-generic-password", "-s", "overdrafter-bitwarden-fixture", "-a", "fixture-account", "-w"],
      ["bw", "unlock", "--passwordenv", "OVD_BW_UNLOCK_PASSWORD", "--raw", "--nointeraction"],
      ["bw", "sync", "--nointeraction"],
      ["bw", "get", "item", "fixture-item-id", "--nointeraction"],
      ["bw", "lock", "--nointeraction"],
    ]);
    const unlock = fake.calls[2];
    expect(unlock.env.OVD_BW_UNLOCK_PASSWORD).toBe(MASTER);
    expect(unlock.env.BW_SESSION).toBeUndefined();
    // The master password reaches exactly one process, through its environment.
    expect(fake.calls.filter((call) => Object.values(call.env).includes(MASTER))).toHaveLength(1);
    for (const call of fake.calls.slice(3)) expect(call.env.BW_SESSION).toBe(SESSION_KEY);
    for (const secret of [MASTER, SESSION_KEY, ITEM_PASSWORD]) expect(everyArgument(fake.calls)).not.toContain(secret);
  });

  it("stops before the keychain when the CLI was never logged in, and on a missing keychain item", async () => {
    const unauthenticated = fakeRunner({ status: JSON.stringify({ status: "unauthenticated" }) });
    await expect(new BitwardenVault(config, baseEnv, unauthenticated.run).open()).rejects.toMatchObject({ code: "vault_not_logged_in" });
    expect(unauthenticated.calls.map((call) => call.file)).toEqual(["bw"]);

    const noItem = fakeRunner({ status: JSON.stringify({ status: "locked" }), security: new BitwardenError("failed") });
    await expect(new BitwardenVault(config, baseEnv, noItem.run).open()).rejects.toMatchObject({ code: "keychain_item_unavailable" });
  });

  it("reports a rejected master password as unlock_failed", async () => {
    const fake = fakeRunner({ status: JSON.stringify({ status: "locked" }), security: MASTER, unlock: new BitwardenError("vault_locked") });
    const failure = await new BitwardenVault(config, baseEnv, fake.run).open().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unlock_failed" });
    expect(String(failure)).not.toContain(MASTER);
  });
});

describe("default execFile runner", () => {
  it("maps CLI failures to fixed codes and never surfaces what the child printed", async () => {
    const script = "process.stderr.write('Not found. leaked-SENTINEL'); process.stdout.write('leaked-SENTINEL'); process.exit(1)";
    const failure = await defaultExecFile(process.execPath, ["-e", script], { env: { PATH: process.env.PATH }, timeoutMs: 20_000 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BitwardenError);
    expect(failure).toMatchObject({ code: "not_found" });
    expect(JSON.stringify(failure)).not.toContain("leaked-SENTINEL");
    expect(String((failure as Error).message)).not.toContain("leaked-SENTINEL");

    const ambiguous = await defaultExecFile(process.execPath, ["-e", "process.stderr.write('More than one result was found.'); process.exit(1)"], {
      env: { PATH: process.env.PATH }, timeoutMs: 20_000,
    }).catch((error: unknown) => error);
    expect(ambiguous).toMatchObject({ code: "ambiguous" });

    await expect(defaultExecFile("/nonexistent/ovd-bw", [], { env: {}, timeoutMs: 5_000 })).rejects.toMatchObject({ code: "cli_missing" });
  });

  it("resolves stdout without a shell", async () => {
    const stdout = await defaultExecFile(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "$(echo not-expanded)"], {
      env: { PATH: process.env.PATH }, timeoutMs: 20_000,
    });
    expect(stdout).toBe("$(echo not-expanded)");
  });
});
