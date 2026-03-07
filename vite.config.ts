import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { buildAppVersion } from "./src/lib/app-version";

const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version?: string;
};
const baseVersion = packageJson.version ?? "0.0.1";
// This is the commit count of the production release that first displayed v0.0.1.
const DEFAULT_PRODUCTION_BASELINE_COMMIT_COUNT = 88;

function parseCommitCount(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readGitCommitCount() {
  try {
    const output = execSync("git rev-list --count HEAD", {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();

    return parseCommitCount(output);
  } catch {
    return null;
  }
}

const productionBaselineCommitCount =
  parseCommitCount(process.env.APP_VERSION_PRODUCTION_BASELINE_COMMIT_COUNT) ??
  DEFAULT_PRODUCTION_BASELINE_COMMIT_COUNT;

const appVersion = buildAppVersion({
  baseVersion,
  deploymentEnvironment: process.env.VERCEL_ENV,
  commitCount: readGitCommitCount(),
  productionBaselineCommitCount,
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    globals: true,
    environment: "jsdom",
    environmentMatchGlobs: [["worker/src/**/*.test.ts", "node"]],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "worker/src/**/*.test.ts"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
}));
