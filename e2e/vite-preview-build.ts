import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview, type PreviewServer } from "vite";

// Shared by journeys that build the production bundle with a flag set or unset and serve it with
// `vite preview`. Synthetic only: callers point Supabase at a closed loopback port.
export const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const viteConfigFile = path.join(repoRoot, "vite.config.ts");

export type EnvOverrides = Record<string, string | undefined>;

type ManifestEntry = { file: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean };

/** Applies env overrides for one scoped step and restores them afterwards. Vite's build sets NODE_ENV for the whole process. */
export async function withEnv<T>(vars: EnvOverrides, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: EnvOverrides) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await run();
  } finally {
    apply(saved);
  }
}

/** Builds production assets with the given env and returns the Vite manifest plus the entry's static import closure. */
export async function buildProductionApp(outDir: string, env: EnvOverrides) {
  await withEnv(env, () => build({
    configFile: viteConfigFile, root: repoRoot, mode: "production", logLevel: "silent",
    build: { outDir, emptyOutDir: true, manifest: true },
  }));
  const manifest = JSON.parse(readFileSync(path.join(outDir, ".vite/manifest.json"), "utf8")) as Record<string, ManifestEntry>;
  const assets = readdirSync(path.join(outDir, "assets"));
  const read = (file: string) => readFileSync(path.join(outDir, file), "utf8");
  // The entry chunk plus everything it loads statically is what every visitor downloads first.
  const staticClosure = (key: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(key)) return seen;
    seen.add(key);
    for (const next of manifest[key]?.imports ?? []) staticClosure(next, seen);
    return seen;
  };
  return { manifest, assets, read, entryClosure: [...staticClosure("index.html")].map((key) => manifest[key].file) };
}

/** Serves a built outDir on 127.0.0.1:port with `vite preview`. */
export async function servePreviewBuild(outDir: string, port: number, env: EnvOverrides): Promise<PreviewServer> {
  return withEnv(env, () => preview({
    configFile: viteConfigFile, root: repoRoot, logLevel: "silent",
    build: { outDir },
    preview: { host: "127.0.0.1", port, strictPort: true },
  }));
}
