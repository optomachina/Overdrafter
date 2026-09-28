import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";
export default defineConfig({
  base: "/sample-plate/", publicDir: false, plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: "dist-sample-plate", sourcemap: false, rollupOptions: { input: path.resolve(__dirname, "sample-plate.html") } },
});
