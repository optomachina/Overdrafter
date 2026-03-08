import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
const faviconVersion = createHash("sha1")
  .update(fs.readFileSync(path.resolve(__dirname, "src/assets/logo.png")))
  .digest("hex")
  .slice(0, 8);

const appVersion = buildAppVersion({
  baseVersion,
  deploymentEnvironment: process.env.VERCEL_ENV,
  commitCount: readGitCommitCount(),
  productionBaselineCommitCount,
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const resolveAlias = {
    "@": path.resolve(__dirname, "./src"),
    path: path.resolve(__dirname, "./src/test/shims/path.ts"),
    crypto: path.resolve(__dirname, "./src/test/shims/crypto.ts"),
  };

  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [
      react(),
      {
        name: "html-favicon-version",
        transformIndexHtml(html) {
          return html.replace(/__FAVICON_VERSION__/g, faviconVersion);
        },
      },
      mode === "development" && componentTagger(),
    ].filter(Boolean),
    resolve: {
      alias: resolveAlias,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/three")) {
              return "three-core";
            }

            if (id.includes("node_modules/occt-import-js")) {
              return "occt-runtime";
            }

            if (id.includes("node_modules/recharts")) {
              return "charts";
            }

            if (id.includes("node_modules/@supabase")) {
              return "supabase";
            }

            if (id.includes("node_modules/@tanstack/react-query")) {
              return "react-query";
            }
          },
        },
      },
      chunkSizeWarningLimit: 750,
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    test: {
      projects: [
        {
        resolve: {
          alias: resolveAlias,
        },
        define: {
          __APP_VERSION__: JSON.stringify(appVersion),
        },
        test: {
          name: "app",
            globals: true,
            environment: "jsdom",
            include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
            setupFiles: ["./src/test/setup.ts"],
            pool: "forks",
            clearMocks: true,
            mockReset: true,
            restoreMocks: true,
          },
        },
        {
        resolve: {
          alias: resolveAlias,
        },
        define: {
          __APP_VERSION__: JSON.stringify(appVersion),
        },
        test: {
          name: "worker",
            globals: true,
            environment: "node",
            include: ["worker/src/**/*.test.ts"],
            clearMocks: true,
            mockReset: true,
            restoreMocks: true,
          },
        },
      ],
    },
  };
});
