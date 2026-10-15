import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { fileURLToPath } from "node:url";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Dedicated test-only entry point; product config never imports this fixture.
export default defineConfig({
  root: local("../.."), envDir: local("./no-environment-files"), envPrefix: "QUOTE_BROWSER_UNUSED_", publicDir: false,
  plugins: [react()],
  resolve: { alias: [
    { find: /^@\/hooks\/use-app-session$/, replacement: local("./session.ts") },
    { find: /^@\/features\/quotes\/api\/workspace-access$/, replacement: local("./workspace.ts") },
    { find: "@", replacement: local("../../src") },
  ] },
  define: {
    __APP_VERSION__: JSON.stringify("synthetic-quote-browser"),
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("http://127.0.0.1:4175"),
    "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("synthetic-unused-anon-key"),
    "import.meta.env.VITE_ENABLE_FIXTURE_MODE": JSON.stringify("0"),
  },
  server: { host: "127.0.0.1", port: 4175, strictPort: true, hmr: false },
  build: { outDir: "dist/quote-confirmation", rollupOptions: { input: local("./index.html") } },
});
