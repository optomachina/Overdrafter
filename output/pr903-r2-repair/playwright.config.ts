import config from "../../playwright.config";
export default {
  ...config,
  testDir: "../../e2e",
  globalSetup: "../../e2e/global-setup.mjs",
  outputDir: "./browser-results",
  webServer: {
    ...config.webServer,
    command: "node output/pr903-r2-repair/vite.mjs",
    cwd: "/Users/blainewilson/Documents/Codex/2026-10-20/overnight/wt/fix-1028",
  },
};
