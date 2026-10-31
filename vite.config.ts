import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { createPrivateFixturePlugin } from "./scripts/vite-private-fixture-plugin";
import { buildAppVersion } from "./src/lib/app-version";
import { samplePlatePlugin } from "./scripts/vite-sample-plate-plugin";

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
const faviconSourcePath = path.resolve(__dirname, "src/assets/favicon-mark.svg");
const faviconVersion = createHash("sha1")
  .update(fs.readFileSync(faviconSourcePath))
  .digest("hex")
  .slice(0, 8);

const appVersion = buildAppVersion({
  baseVersion,
  deploymentEnvironment: process.env.VERCEL_ENV,
  commitCount: readGitCommitCount(),
  productionBaselineCommitCount,
});
const fixtureModeEnabled = process.env.VITE_ENABLE_FIXTURE_MODE === "1";
const samplePlateEnabled = process.env.OVD_SAMPLE_PLATE_DEMO_ENABLED === "1";
const quoteIntegrationEnabled = process.env.RUN_QUOTE_INTEGRATION_TESTS === "1";
const fictivLiveTestEnabled = process.env.RUN_FICTIV_LIVE_TEST === "1";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: fixtureModeEnabled || samplePlateEnabled ? "127.0.0.1" : "::",
    port: samplePlateEnabled ? 8091 : 8080,
    strictPort: samplePlateEnabled,
  },
  preview: {
    host: fixtureModeEnabled ? "127.0.0.1" : undefined,
  },
  plugins: [
    react(),
    samplePlateEnabled && samplePlatePlugin(__dirname),
    {
      name: "html-favicon-version",
      transformIndexHtml(html: string) {
        return html.replace(/__FAVICON_VERSION__/g, faviconVersion);
      },
    },
    fixtureModeEnabled && createPrivateFixturePlugin(__dirname),
    mode === "development" && componentTagger(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  envPrefix: ["VITE_", "JARVIS_PWA_"],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    // Vite inlines every file under 4 KiB as a data: URL, and Vite 5 has no per-import opt-out (`?no-inline`
    // is a no-op here). The Jarvis thread accepts only https: and blob: artifact URLs, and every preview
    // fixture is smaller than 4 KiB, so these must be emitted as files. Returning undefined keeps the
    // default threshold for everything else.
    assetsInlineLimit: (file: string) => (file.includes("/src/features/jarvis/thread/preview-assets/") ? false : undefined),
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        "mobile-auth": path.resolve(__dirname, "src/mobile-auth/ceremony-entry.ts"),
        "mobile-bootstrap": path.resolve(__dirname, "src/mobile-auth/bootstrap-entry.ts"),
      },
      output: {
        entryFileNames(chunkInfo) {
          if (chunkInfo.name === "mobile-auth" || chunkInfo.name === "mobile-bootstrap") {
            return `assets/${chunkInfo.name}.js`;
          }

          return "assets/[name]-[hash].js";
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: process.env.OVD_SOURCE_ONLY_TESTS === "1"
      ? ["./scripts/test-support/source-only-network.setup.mjs"]
      : [],
    include: [
      "api/**/*.test.ts",
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "worker/src/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "scripts/native-storage-qualification.test.ts",
    ],
    exclude: [
      ...configDefaults.exclude,
      ...(quoteIntegrationEnabled ? [] : ["scripts/api-request-quote.test.mjs"]),
      ...(fictivLiveTestEnabled ? [] : ["worker/src/**/*.live.test.ts"]),
    ],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
  },
}));
