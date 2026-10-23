import { constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * OVD-1060: the private, per-machine configuration for unattended vendor
 * login. It names Bitwarden items and local paths, so it lives outside the
 * (public) repository, owner-only. It never holds a password.
 */

export const DEFAULT_VENDOR_LOGIN_CONFIG_PATH = path.join(os.homedir(), ".config", "overdrafter", "vendor-login.json");
export const DEFAULT_VENDOR_LOGIN_LOG_PATH = path.join(os.homedir(), "Library", "Logs", "overdrafter", "vendor-login.log");

/** The checkout this file belongs to (worker/src/tools -> repository root). */
export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const itemReference = z.string().trim().min(1).max(200).refine(
  (value) => ![...value].some((char) => (char.codePointAt(0) ?? 0) < 0x20 || char.codePointAt(0) === 0x7f),
  { message: "must not contain control characters" },
);

const localPath = z.string().trim().min(1).max(1024);

const configSchema = z.object({
  stateDir: localPath.optional(),
  logFile: localPath.optional(),
  headless: z.boolean().default(true),
  bitwarden: z.object({
    cliPath: localPath.default("bw"),
    unlock: z.enum(["session-env", "keychain"]).default("session-env"),
    keychainService: z.string().trim().min(1).max(200).optional(),
    keychainAccount: z.string().trim().min(1).max(200).optional(),
  }).strict().default({}),
  vendors: z.record(z.string(), z.object({ item: itemReference }).strict()),
}).strict().superRefine((config, context) => {
  if (config.bitwarden.unlock === "keychain" && !config.bitwarden.keychainService) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bitwarden", "keychainService"], message: "is required for keychain unlock" });
  }
});

export type VendorLoginConfig = z.infer<typeof configSchema>;
export type BitwardenConfig = VendorLoginConfig["bitwarden"];

export function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The real path of a file that may not exist yet: its nearest existing ancestor, resolved, plus the rest. */
function canonicalPath(filePath: string): string {
  let existing = path.resolve(filePath);
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...rest);
}

/**
 * This checkout, plus the main checkout when this one is a linked worktree
 * (its `.git` is a file naming `<main>/.git/worktrees/<name>`).
 */
export function checkoutRoots(repositoryRoot = REPOSITORY_ROOT): string[] {
  const roots = [canonicalPath(repositoryRoot)];
  try {
    const marker = readFileSync(path.join(repositoryRoot, ".git"), "utf8");
    const gitDir = /^gitdir:[ \t]*(\S.*)$/m.exec(marker)?.[1]?.trim();
    const resolved = gitDir ? path.resolve(repositoryRoot, gitDir) : "";
    const worktreesMarker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const index = resolved.lastIndexOf(worktreesMarker);
    if (index > 0 && !resolved.slice(index + worktreesMarker.length).includes(path.sep)) {
      roots.push(canonicalPath(resolved.slice(0, index)));
    }
  } catch {
    // A directory .git (or none) means this is the main checkout.
  }
  return roots;
}

/** Refuses a private path that resolves inside any checkout of the public repository, where it could be committed. */
export function assertOutsideRepository(filePath: string, label: string, repositoryRoot = REPOSITORY_ROOT): void {
  const target = canonicalPath(filePath);
  if (checkoutRoots(repositoryRoot).some((root) => isInside(target, root))) {
    throw new Error(`The ${label} must live outside the repository checkout.`);
  }
}

/**
 * Reads the login config. The file must be a regular file (not a symlink)
 * owned by this user with no group or other permission bits, and outside
 * the checkout.
 */
export async function readVendorLoginConfig(options: {
  path?: string | null;
  env?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
} = {}): Promise<VendorLoginConfig> {
  const env = options.env ?? process.env;
  const configPath = path.resolve(expandHome(options.path ?? env.OVD_VENDOR_LOGIN_CONFIG ?? DEFAULT_VENDOR_LOGIN_CONFIG_PATH));
  assertOutsideRepository(configPath, "vendor login config", options.repositoryRoot);
  // Checked and read through one descriptor opened without following a symlink.
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(configPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("The vendor login config must be a regular file, not a symlink.");
    }
    throw new Error(`Vendor login config not found at ${configPath}.`);
  }
  let text: string;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("The vendor login config must be a regular file, not a symlink.");
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error("The vendor login config must be owned by the current user.");
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`The vendor login config must be owner-only. Run: chmod 600 ${configPath}`);
    }
    text = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The vendor login config is not valid JSON.");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`);
    throw new Error(`The vendor login config is invalid: ${issues.join("; ")}`);
  }
  return parsed.data;
}

/** `--state-dir`, else `QUOTE_VENDOR_STORAGE_STATE_DIR`, else the config's `stateDir`. */
export function resolveStateDir(input: {
  flag: string | null;
  env: NodeJS.ProcessEnv;
  config: Pick<VendorLoginConfig, "stateDir"> | null;
}): string {
  const raw = input.flag ?? input.env.QUOTE_VENDOR_STORAGE_STATE_DIR ?? input.config?.stateDir;
  if (!raw) {
    throw new Error("No session directory: pass --state-dir, set QUOTE_VENDOR_STORAGE_STATE_DIR, or set stateDir in the login config.");
  }
  return path.resolve(expandHome(raw));
}

export function resolveLogPath(config: Pick<VendorLoginConfig, "logFile"> | null, repositoryRoot = REPOSITORY_ROOT): string {
  const logPath = path.resolve(expandHome(config?.logFile ?? DEFAULT_VENDOR_LOGIN_LOG_PATH));
  assertOutsideRepository(logPath, "vendor login log", repositoryRoot);
  return logPath;
}
