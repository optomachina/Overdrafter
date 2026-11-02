import { execFile } from "node:child_process";
import { inspect } from "node:util";
import type { BitwardenConfig } from "./vendorLoginConfig.js";

/**
 * OVD-1060: reads vendor logins from the Bitwarden CLI for `login:vendors`.
 *
 * - Every command runs through execFile (no shell) with a minimal
 *   environment. No secret is ever an argument: the keychain unlock hands
 *   the master password to `bw unlock --passwordenv`, and the session key
 *   travels as BW_SESSION.
 * - Secrets are held in `SecretString`, which prints as "[redacted]" in
 *   logs, JSON, string interpolation and util.inspect.
 * - Failures carry a fixed code only. CLI output and stderr never leave this
 *   module, because either could echo vault content.
 */

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "[redacted]";
  }
}

export type BitwardenErrorCode =
  | "cli_missing"
  | "timeout"
  | "not_found"
  | "ambiguous"
  | "vault_locked"
  | "vault_not_logged_in"
  | "session_env_missing"
  | "keychain_item_unavailable"
  | "unlock_failed"
  | "item_not_a_login"
  | "item_uri_mismatch"
  | "unexpected_output"
  | "failed";

export class BitwardenError extends Error {
  constructor(readonly code: BitwardenErrorCode) {
    super(`Bitwarden ${code.replaceAll("_", " ")}.`);
    this.name = "BitwardenError";
  }
}

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<string>;

function failureCode(error: { code?: string | number | null; killed?: boolean }, stderr: string): BitwardenErrorCode {
  if (error.code === "ENOENT") return "cli_missing";
  if (error.killed) return "timeout";
  if (/more than one result/i.test(stderr)) return "ambiguous";
  if (/not found/i.test(stderr)) return "not_found";
  if (/you are not logged in|unauthenticated/i.test(stderr)) return "vault_not_logged_in";
  if (/vault is locked|session key|invalid master password/i.test(stderr)) return "vault_locked";
  return "failed";
}

/** execFile without a shell; resolves stdout, rejects with a fixed code and nothing the child printed. */
export const defaultExecFile: ExecFileRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], {
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  }, (error, stdout, stderr) => {
    if (error) {
      reject(new BitwardenError(failureCode(error, String(stderr ?? ""))));
      return;
    }
    resolve(String(stdout));
  });
});

const PASSTHROUGH_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "BITWARDENCLI_APPDATA_DIR", "NODE_EXTRA_CA_CERTS"];

/** Only what the CLIs need; worker secrets such as Supabase keys never reach a child process. */
export function childEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { BW_NOINTERACTION: "true" };
  for (const name of PASSTHROUGH_ENV) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  return { ...child, ...extra };
}

/** Only what a browser or notifier needs: no vault session, no worker secrets. */
export function minimalChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    if (name !== "BITWARDENCLI_APPDATA_DIR" && env[name] !== undefined) child[name] = env[name];
  }
  return child;
}

export type LoginCredential = {
  username: SecretString;
  password: SecretString;
};

const SECURITY_CLI = "/usr/bin/security";
const COMMAND_TIMEOUT_MS = 60_000;
const UNLOCK_PASSWORD_ENV = "OVD_BW_UNLOCK_PASSWORD";

function registrableLabels(host: string): number {
  return host.split(".").filter(Boolean).length;
}

/**
 * True when a Bitwarden item URI names one of the vendor's reviewed hosts,
 * a parent domain of one (at least two labels), or a subdomain of one. A
 * login saved for another site is never typed into a vendor page.
 */
export function itemUriMatchesHosts(rawUri: string, hosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUri) ? rawUri : `https://${rawUri}`);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const itemHost = url.hostname.toLowerCase();
  if (registrableLabels(itemHost) < 2) return false;
  return hosts.some((raw) => {
    const host = raw.toLowerCase();
    return host === itemHost || host.endsWith(`.${itemHost}`) || itemHost.endsWith(`.${host}`);
  });
}

type ItemJson = {
  type?: unknown;
  login?: { username?: unknown; password?: unknown; uris?: Array<{ uri?: unknown }> | null } | null;
};

export function parseLoginItem(stdout: string, hosts: readonly string[]): LoginCredential {
  let item: ItemJson;
  try {
    item = JSON.parse(stdout) as ItemJson;
  } catch {
    throw new BitwardenError("unexpected_output");
  }
  const login = item?.login;
  if (item?.type !== 1 || !login
    || typeof login.username !== "string" || !login.username
    || typeof login.password !== "string" || !login.password) {
    throw new BitwardenError("item_not_a_login");
  }
  const uris = Array.isArray(login.uris)
    ? login.uris.map((entry) => entry?.uri).filter((uri): uri is string => typeof uri === "string")
    : [];
  if (!uris.some((uri) => itemUriMatchesHosts(uri, hosts))) throw new BitwardenError("item_uri_mismatch");
  return { username: new SecretString(login.username), password: new SecretString(login.password) };
}

/**
 * One unlocked Bitwarden session for one `login:vendors` run. In
 * `session-env` mode the caller already exported BW_SESSION; in `keychain`
 * mode this reads the master password from the macOS login keychain,
 * unlocks, and locks the vault again in `close()`.
 */
export class BitwardenVault {
  #session: SecretString | null = null;
  #unlockedHere = false;
  /** Captured at construction so the caller can drop BW_SESSION from its own environment. */
  readonly #exportedSession: SecretString | null;

  constructor(
    private readonly config: BitwardenConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly run: ExecFileRunner = defaultExecFile,
  ) {
    const exported = env.BW_SESSION?.trim();
    this.#exportedSession = exported ? new SecretString(exported) : null;
  }

  #bw(args: readonly string[], extra: Record<string, string> = {}): Promise<string> {
    const session: Record<string, string> = this.#session ? { BW_SESSION: this.#session.reveal() } : {};
    return this.run(this.config.cliPath, [...args, "--nointeraction"], {
      env: childEnv(this.env, { ...session, ...extra }),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
  }

  async #status(): Promise<string> {
    try {
      const parsed = JSON.parse(await this.#bw(["status"])) as { status?: unknown };
      return typeof parsed.status === "string" ? parsed.status : "unknown";
    } catch (error) {
      if (error instanceof BitwardenError) throw error;
      throw new BitwardenError("unexpected_output");
    }
  }

  async open(): Promise<void> {
    if (this.config.unlock === "session-env") {
      if (!this.#exportedSession) throw new BitwardenError("session_env_missing");
      this.#session = this.#exportedSession;
      if ((await this.#status()) !== "unlocked") throw new BitwardenError("vault_locked");
    } else {
      this.#session = null;
      const status = await this.#status();
      if (status === "unauthenticated") throw new BitwardenError("vault_not_logged_in");
      const master = await this.#keychainPassword();
      let key: string;
      try {
        key = (await this.#bw(["unlock", "--passwordenv", UNLOCK_PASSWORD_ENV, "--raw"], {
          [UNLOCK_PASSWORD_ENV]: master.reveal(),
        })).trim();
      } catch (error) {
        throw new BitwardenError(error instanceof BitwardenError && error.code === "timeout" ? "timeout" : "unlock_failed");
      }
      if (!key) throw new BitwardenError("unlock_failed");
      this.#session = new SecretString(key);
      this.#unlockedHere = true;
    }
    // A stale local cache would hand back an old password; a failed sync is not fatal.
    await this.#bw(["sync"]).catch(() => undefined);
  }

  async #keychainPassword(): Promise<SecretString> {
    const args = ["find-generic-password", "-s", this.config.keychainService ?? ""];
    if (this.config.keychainAccount) args.push("-a", this.config.keychainAccount);
    args.push("-w");
    let stdout: string;
    try {
      stdout = await this.run(SECURITY_CLI, args, { env: childEnv(this.env), timeoutMs: COMMAND_TIMEOUT_MS });
    } catch {
      throw new BitwardenError("keychain_item_unavailable");
    }
    const password = stdout.replace(/\r?\n$/, "");
    if (!password) throw new BitwardenError("keychain_item_unavailable");
    return new SecretString(password);
  }

  /** The username and password of one login item whose URI names a reviewed vendor host. */
  async loginItem(reference: string, hosts: readonly string[]): Promise<LoginCredential> {
    if (!this.#session) throw new BitwardenError("vault_locked");
    return parseLoginItem(await this.#bw(["get", "item", reference]), hosts);
  }

  async close(): Promise<void> {
    if (this.#unlockedHere) await this.#bw(["lock"]).catch(() => undefined);
    this.#session = null;
    this.#unlockedHere = false;
  }
}
