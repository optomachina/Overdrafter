// @vitest-environment node

import { describe, expect, it } from "vitest";
import { VendorAdapter } from "./base";
import type {
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOutput,
  WorkerConfig,
} from "../types";

const workerConfig: WorkerConfig = {
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "service-role-key",
  workerMode: "simulate",
  workerName: "worker-1",
  pollIntervalMs: 5000,
  httpHost: "0.0.0.0",
  httpPort: 8080,
  workerTempDir: "/tmp/overdrafter-worker",
  artifactBucket: "quote-artifacts",
  playwrightHeadless: true,
  playwrightCaptureTrace: false,
  browserTimeoutMs: 30000,
  playwrightDisableSandbox: false,
  playwrightDisableDevShmUsage: true,
  xometryStorageStatePath: null,
  xometryStorageStateJson: null,
  xometryUserDataDir: null,
  xometryBrowserChannel: null,
  xometryProfileLockWaitMs: 0,
};

class TestVendorAdapter extends VendorAdapter {
  async quote(): Promise<VendorQuoteAdapterOutput> {
    throw new Error("Not implemented for test");
  }

  getSimulatedBaseAmount(input: VendorQuoteAdapterInput): number {
    return this.simulatedBaseAmount(input);
  }
}

function makeInput(overrides: Partial<VendorQuoteAdapterInput> = {}): VendorQuoteAdapterInput {
  return {
    organizationId: "org-1",
    quoteRunId: "run-1",
    requestedQuantity: 2,
    part: {
      id: "part-1",
      job_id: "job-1",
      organization_id: "org-1",
      name: "Bracket",
      normalized_key: "bracket",
      cad_file_id: null,
      drawing_file_id: null,
      quantity: 2,
    },
    cadFile: null,
    drawingFile: null,
    stagedCadFile: null,
    stagedDrawingFile: null,
    requirement: {
      id: "req-1",
      part_id: "part-1",
      description: "Bracket",
      part_number: "1093-00001",
      revision: "A",
      material: "7075 aluminum",
      finish: null,
      tightest_tolerance_inch: 0.0025,
      quantity: 2,
      quote_quantities: [2],
      requested_by_date: null,
      applicable_vendors: ["xometry"],
    },
    ...overrides,
  } as VendorQuoteAdapterInput;
}

describe("VendorAdapter.simulatedBaseAmount", () => {
  it("applies tight-tolerance and material multipliers", () => {
    const adapter = new TestVendorAdapter("xometry", workerConfig);

    expect(adapter.getSimulatedBaseAmount(makeInput())).toBe(84.24);
  });

  it("uses the part quantity fallback and alternate multipliers when requirement quantity is absent", () => {
    const adapter = new TestVendorAdapter("fictiv", workerConfig);

    expect(
      adapter.getSimulatedBaseAmount(
        makeInput({
          requestedQuantity: 0,
          part: {
            id: "part-2",
            job_id: "job-1",
            organization_id: "org-1",
            name: "Housing",
            normalized_key: "housing",
            cad_file_id: null,
            drawing_file_id: null,
            quantity: 3,
          },
          requirement: {
            id: "req-2",
            part_id: "part-2",
            description: "Housing",
            part_number: "1093-00002",
            revision: null,
            material: "PEEK",
            finish: null,
            tightest_tolerance_inch: 0.004,
            quantity: 0,
            quote_quantities: [3],
            requested_by_date: null,
            applicable_vendors: ["fictiv"],
          },
        }),
      ),
    ).toBe(91.77);
  });
});
