import type { WorkerConfig } from "./types.js";

type ChromiumSandboxSettings = Pick<
  WorkerConfig,
  "playwrightDisableSandbox" | "playwrightDisableDevShmUsage"
>;

/**
 * Sandbox and shared-memory launch options for the service and job Chromium
 * launchers. The headed operator auth tools do not use it yet (OVD-610).
 *
 * Playwright adds `--no-sandbox` itself unless `chromiumSandbox` is exactly
 * `true`, so leaving the flag out of `args` does not turn the sandbox on. The
 * sandbox decision therefore has to be passed explicitly. The explicit flags
 * stay in place for the `PLAYWRIGHT_DISABLE_SANDBOX=true` opt-out.
 */
export function chromiumSandboxLaunchOptions(settings: ChromiumSandboxSettings): {
  args: string[];
  chromiumSandbox: boolean;
} {
  const args: string[] = [];
  if (settings.playwrightDisableSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  if (settings.playwrightDisableDevShmUsage) {
    args.push("--disable-dev-shm-usage");
  }
  return { args, chromiumSandbox: !settings.playwrightDisableSandbox };
}
