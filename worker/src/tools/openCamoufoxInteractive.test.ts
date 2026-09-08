// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  camoufox: vi.fn(), options: vi.fn(), launch: vi.fn(), mkdir: vi.fn(),
}));
vi.mock("dotenv/config", () => ({}));
vi.mock("node:fs/promises", () => ({ default: { mkdir: mocks.mkdir } }));
vi.mock("camoufox-js", () => ({ Camoufox: mocks.camoufox, launchOptions: mocks.options }));
vi.mock("playwright", () => ({ firefox: { launch: mocks.launch } }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("interactive Camoufox setup", () => {
  it.each([true, false])("disables lookup before navigation (persistent=%s)", async (persistent) => {
    vi.resetModules();
    vi.stubEnv("XOMETRY_USER_DATA_DIR", persistent ? "/synthetic-profile" : "");
    vi.stubEnv("XOMETRY_STORAGE_STATE_PATH", "");
    const stopped = new Error("offline test stops before provider navigation");
    const page = { goto: vi.fn().mockRejectedValue(stopped) };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    mocks.camoufox.mockResolvedValue(context);
    mocks.options.mockResolvedValue({ headless: false });
    mocks.launch.mockResolvedValue({ newContext: vi.fn().mockResolvedValue(context) });

    await expect(import("./openCamoufoxInteractive")).rejects.toThrow(stopped);
    const selected = persistent ? mocks.camoufox : mocks.options;
    expect(selected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ geoip: false }));
    expect(persistent ? mocks.options : mocks.camoufox).not.toHaveBeenCalled();
  });
});
