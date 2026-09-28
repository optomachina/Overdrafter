import type { Plugin } from "vite";
import path from "node:path";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createPlateAdapter } from "../server/engineering/sample-plate-adapter";
import { HELPER_HASH, newCapability, PlateDispatcher } from "../server/engineering/sample-plate-dispatch";
import { createPlateHttp, PLATE_API } from "../server/engineering/sample-plate-http";

export function insideDirectory(candidate: string, directory: string) {
  const canonical = (value: string) => (existsSync(value) ? realpathSync(value) : path.join(realpathSync(path.dirname(value)), path.basename(value))).replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");
  const c = canonical(candidate), d = canonical(directory);
  return c === d || c.startsWith(d + "/");
}

export function samplePlatePlugin(repoRoot: string): Plugin {
  return {
    name: "local-sample-plate", apply: "serve",
    config(_config, env) { if (env.isPreview) throw new Error("Sample plate is unavailable in preview"); },
    configResolved(config) {
      if (config.command !== "serve" || config.mode !== "development" || config.server.host !== "127.0.0.1" || !config.server.strictPort || !config.server.fs.strict)
        throw new Error("Sample plate requires development serve on 127.0.0.1 with strictPort");
      if (process.env.OVD_SAMPLE_OUTPUT_ROOT) config.server.fs.deny.push(path.resolve(process.env.OVD_SAMPLE_OUTPUT_ROOT).replaceAll("\\", "/") + "/**");
    },
    configureServer(server) {
      const required = (name: string) => { const value = process.env[name]; if (!value) { throw new Error(`Missing server configuration: ${name}`); } return value; };
      const root = path.resolve(required("OVD_SAMPLE_OUTPUT_ROOT"));
      if (!path.isAbsolute(required("OVD_SAMPLE_OUTPUT_ROOT")) || insideDirectory(root, repoRoot)
        || server.config.server.fs.allow.some(allowed => insideDirectory(root, allowed))) throw new Error("Sample outputs must be outside every web file allowlist");
      const python = required("OVD_SAMPLE_PYTHON"), helper = required("OVD_SAMPLE_HELPER"), jev = required("OVD_SAMPLE_JEV_HELPER");
      const pid = Number(required("OVD_SAMPLE_SW_PID")), processStarted = Number(required("OVD_SAMPLE_SW_STARTED"));
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(processStarted) || processStarted <= 0) throw new Error("Invalid retained SolidWorks identity");
      const adapter = createPlateAdapter({ python, helper, jev, root, pid, processStarted, nativeScript: path.join(repoRoot, "scripts/native/sample-plate/run.py") });
      const dispatcher = new PlateDispatcher(root, adapter, { helperHash: HELPER_HASH, pid: String(pid), processStarted: String(processStarted), outputRoot: root });
      const capability = newCapability(); const origin = `http://127.0.0.1:${server.config.server.port}`;
      const handle = createPlateHttp(dispatcher, origin, capability);
      // Private local launch artifact, outside Vite's allowlist. Never a Jev key.
      writeFileSync(path.join(root, "launch-url.txt"), `${origin}/dev/engineering/plate#launch=${capability}`, { mode: 0o600 });
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith(PLATE_API)) { void handle(req, res); return; }
        next();
      });
    },
  };
}
