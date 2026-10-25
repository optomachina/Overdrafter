import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  __resetWorkerWakeForTests,
  isWorkerWakeEnabled,
  requestWorkerWake,
  WORKER_WAKE_RPC_ALLOWLIST,
} from "./worker-wake";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

describe("worker wake", () => {
  let timestamp: number;
  const invoke = vi.mocked(supabase.functions.invoke);

  beforeEach(() => {
    timestamp = 0;
    __resetWorkerWakeForTests(() => timestamp);
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "true");
    invoke.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    __resetWorkerWakeForTests();
    vi.unstubAllEnvs();
  });

  it("accepts only the supported opt-in switches, ignoring case", () => {
    for (const value of ["true", "TRUE", "TrUe", "1", "on", "ON", "On"]) {
      vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", value);
      expect(isWorkerWakeEnabled()).toBe(true);
    }
  });

  it("defaults off and ignores unsupported switches", () => {
    for (const value of [undefined, "", "false", "0", "off", "yes", " true "]) {
      vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", value);
      expect(isWorkerWakeEnabled()).toBe(false);
      requestWorkerWake("api_request_extraction");
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes the wake function with an empty body for each allowlisted RPC", () => {
    for (const fn of WORKER_WAKE_RPC_ALLOWLIST) {
      __resetWorkerWakeForTests(() => timestamp);
      expect(requestWorkerWake(fn)).toBeUndefined();
      expect(invoke).toHaveBeenLastCalledWith("worker-wake", { body: {} });
    }
    expect(invoke).toHaveBeenCalledTimes(9);
  });

  it("ignores read and unknown RPCs without consuming the debounce window", () => {
    requestWorkerWake("api_list_jobs");
    requestWorkerWake("unknown_rpc");
    expect(invoke).not.toHaveBeenCalled();

    requestWorkerWake("api_request_extraction");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("debounces across RPC names for ten seconds without extending the window", () => {
    requestWorkerWake("api_request_extraction");
    timestamp = 9_999;
    requestWorkerWake("api_request_quotes");
    expect(invoke).toHaveBeenCalledTimes(1);

    timestamp = 10_000;
    requestWorkerWake("api_request_quotes");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not consume the debounce window while disabled", () => {
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "false");
    requestWorkerWake("api_request_extraction");
    vi.stubEnv("VITE_WORKER_WAKE_ON_SUBMIT", "true");
    requestWorkerWake("api_request_extraction");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("swallows rejected invocations and still debounces the attempt", async () => {
    invoke.mockRejectedValue(new Error("Sensitive wake failure payload"));
    expect(requestWorkerWake("api_request_extraction")).toBeUndefined();
    await Promise.resolve();
    requestWorkerWake("api_request_quotes");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("swallows synchronous invocation failures and still debounces the attempt", () => {
    invoke.mockImplementation(() => {
      throw new Error("Sensitive wake failure payload");
    });
    expect(() => requestWorkerWake("api_request_extraction")).not.toThrow();
    requestWorkerWake("api_request_quotes");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
