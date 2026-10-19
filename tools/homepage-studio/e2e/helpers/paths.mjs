// Absolute paths shared by the e2e helpers.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const e2eDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const studioRoot = path.resolve(e2eDir, "..");
export const repoRoot = path.resolve(studioRoot, "..", "..");
export const publicDir = path.join(repoRoot, "public");
// Everything Playwright writes (traces, screenshots, reports) goes here, never into the repo.
export const outputRoot = path.join(os.tmpdir(), "homepage-studio-e2e-output");
