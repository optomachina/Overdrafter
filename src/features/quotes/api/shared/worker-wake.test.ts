import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
let workerWake: typeof import("./worker-wake");

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

describe("worker wake", () => {
  const invoke = vi.mocked(supabase.functions.invoke);

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    workerWake = await import("./worker-wake");
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "true");
    invoke.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("accepts only the supported opt-in switches, ignoring case", () => {
    for (const value of ["true", "TRUE", "TrUe", "1", "on", "ON", "On"]) {
      vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", value);
      expect(workerWake.isWorkerWakeEnabled()).toBe(true);
    }
  });

  it("defaults off and ignores unsupported switches", () => {
    for (const value of [undefined, "", "false", "0", "off", "yes", " true "]) {
      vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", value);
      expect(workerWake.isWorkerWakeEnabled()).toBe(false);
      workerWake.requestWorkerWake("api_request_extraction");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  const expectedAllowlist = [
    "api_request_extraction",
    "api_request_debug_extraction",
    "api_request_provider_dispatch",
    "api_request_xometry_beta_dispatch",
    "api_start_quote_run",
    "api_request_export_marking_rescan",
  ];

  it("allowlists exactly the six RPCs that enqueue work", () => {
    expect([...workerWake.WORKER_WAKE_RPC_ALLOWLIST].sort()).toEqual([...expectedAllowlist].sort());
  });

  it.each(expectedAllowlist)("wakes for %s with an empty body", (fn) => {
    expect(workerWake.requestWorkerWake(fn)).toBeUndefined();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("worker-wake", { body: {} });
  });

  it.each([
    "api_request_quotes",
    "api_enqueue_debug_vendor_quote",
    "api_request_manual_quote",
    "api_request_manual_quotes",
  ])("does not wake for removed RPC %s or consume the debounce window", (fn) => {
    workerWake.requestWorkerWake(fn);
    expect(invoke).not.toHaveBeenCalled();
    workerWake.requestWorkerWake("api_request_extraction");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("ignores read and unknown RPCs without consuming the debounce window", () => {
    workerWake.requestWorkerWake("api_list_jobs");
    workerWake.requestWorkerWake("unknown_rpc");
    expect(invoke).not.toHaveBeenCalled();

    workerWake.requestWorkerWake("api_request_extraction");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("debounces across RPC names for ten seconds without extending the window", () => {
    workerWake.requestWorkerWake("api_request_extraction");
    vi.setSystemTime(9_999);
    workerWake.requestWorkerWake("api_start_quote_run");
    expect(invoke).toHaveBeenCalledTimes(1);

    vi.setSystemTime(10_000);
    workerWake.requestWorkerWake("api_start_quote_run");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not consume the debounce window while disabled", () => {
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "false");
    workerWake.requestWorkerWake("api_request_extraction");
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "true");
    workerWake.requestWorkerWake("api_request_extraction");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("swallows rejected invocations and still debounces the attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockRejectedValue(new Error("Sensitive wake failure payload"));
    expect(workerWake.requestWorkerWake("api_request_extraction")).toBeUndefined();
    await Promise.resolve();
    workerWake.requestWorkerWake("api_start_quote_run");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith("worker wake request failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Sensitive wake failure payload");
  });

  it("swallows synchronous invocation failures and still debounces the attempt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockImplementation(() => {
      throw new Error("Sensitive wake failure payload");
    });
    expect(() => workerWake.requestWorkerWake("api_request_extraction")).not.toThrow();
    workerWake.requestWorkerWake("api_start_quote_run");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith("worker wake request failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Sensitive wake failure payload");
  });
});
