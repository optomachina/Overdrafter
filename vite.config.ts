import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import path from "path";
import { componentTagger } from "lovable-tagger";

const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as {
  version?: string;
};
const appVersion = packageJson.version ?? "0.0.1";

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
