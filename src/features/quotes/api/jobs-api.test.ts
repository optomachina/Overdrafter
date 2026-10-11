import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { updateClientPartRequest } from "./jobs-api";

const { callRpcMock } = vi.hoisted(() => ({
  callRpcMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/features/quotes/client-workspace-fixtures", () => ({
  getActiveClientWorkspaceGateway: () => null,
}));
vi.mock("./shared/rpc", () => ({
  callRpc: callRpcMock,
  callUntypedRpc: vi.fn(),
}));

const extractionObject = {
  raw: null,
  reasons: [],
  confidence: 0,
  normalized: null,
  reviewNeeded: false,
};

function makeInput(finish: unknown): ClientPartRequestUpdateInput {
  return {
    jobId: "job-1",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    material: "6061-T6",
    finish,
    tightestToleranceInch: 0.001,
    quantity: 5,
    requestedQuoteQuantities: [5],
    shipping: {},
    certifications: [],
    sourcing: {},
    release: {},
  } as unknown as ClientPartRequestUpdateInput;
}

describe("updateClientPartRequest finish handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves tolerance while leaving a string finish intact", async () => {
    callRpcMock.mockResolvedValue({ data: "job-1", error: null });

    await updateClientPartRequest(makeInput("Black anodize"));

    expect(callRpcMock).toHaveBeenCalledWith(
      "api_update_client_part_request",
      expect.objectContaining({ p_finish: "Black anodize", p_tightest_tolerance_inch: 0.001 }),
    );
  });

  it("sends a null finish instead of a raw JSON object on the primary path", async () => {
    callRpcMock.mockResolvedValue({ data: "job-1", error: null });

    await updateClientPartRequest(makeInput(extractionObject));

    expect(callRpcMock).toHaveBeenCalledTimes(1);
    expect(callRpcMock.mock.calls[0][1]).toMatchObject({ p_finish: null, p_tightest_tolerance_inch: 0.001 });
  });

  it("sends a null finish instead of a raw JSON object on the legacy fallback path", async () => {
    callRpcMock
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function api_update_client_part_request",
          details: "",
          hint: "",
        },
      })
      .mockResolvedValueOnce({ data: "job-1", error: null });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await updateClientPartRequest(makeInput(extractionObject));

    expect(callRpcMock).toHaveBeenCalledTimes(2);
    expect(callRpcMock.mock.calls[1][1]).toMatchObject({ p_finish: null, p_tightest_tolerance_inch: 0.001 });
  });
});
