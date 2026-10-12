import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// Never imported by the product config. The page mounts only synthetic quote data.
const FIXTURE_PATH = "/fixture/delivered-comparison";
const stubs: Record<string, string> = {
  "@/integrations/supabase/client": "export const supabase=new Proxy({},{get(){throw new Error('Supabase is unavailable in the delivered-comparison fixture.');}});",
};

export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  plugins: [{
    name: "delivered-comparison-synthetic-only", enforce: "pre",
    resolveId(id) {
      const src = path.resolve(import.meta.dirname, "../src");
      const key = id.startsWith(src + "/") ? "@/" + id.slice(src.length + 1).replace(/\.tsx?$/, "") : id;
      if (key in stubs) return `\0delivered-fixture:${key}`;
    },
    load(id) { if (id.startsWith("\0delivered-fixture:")) return stubs[id.slice("\0delivered-fixture:".length)]; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== FIXTURE_PATH) return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url!, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/e2e/delivered-comparison.fixture.tsx"></script></body></html>'));
      });
    },
  }, react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../src") } },
  define: { __APP_VERSION__: JSON.stringify("synthetic-test") },
  server: { host: "127.0.0.1", port: 4175, strictPort: true },
});
