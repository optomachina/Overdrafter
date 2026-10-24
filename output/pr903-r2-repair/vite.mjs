import { createServer } from "vite";
const server = await createServer({
  configFile: "/Users/blainewilson/Documents/Codex/2026-10-20/overnight/wt/fix-1028/vite.config.ts",
  cacheDir: "/tmp/pr903-r2-vite-cache",
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
});
await server.listen();
