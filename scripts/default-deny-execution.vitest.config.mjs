import { configDefaults, defineConfig } from "vitest/config";

import baseConfig from "../vite.config.ts";

/**
 * The repository vitest config with `include` narrowed to the default-deny
 * files named in OVD_DEFAULT_DENY_FILES. Used only by default-deny-execution.mjs.
 */
export default defineConfig(async (env) => {
  const base = typeof baseConfig === "function" ? await baseConfig(env) : baseConfig;
  const files = JSON.parse(process.env.OVD_DEFAULT_DENY_FILES ?? "[]");
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("OVD_DEFAULT_DENY_FILES must name at least one test file");
  }
  return {
    ...base,
    test: { ...base.test, include: files, exclude: [...configDefaults.exclude] },
  };
});
