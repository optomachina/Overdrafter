// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { runFictivQuantitySweep } from "./fictivQuantitySweep.js";
import { runEvaluationBatch } from "./vendorWorkflowSmoke.js";

describe("runFictivQuantitySweep", () => {
  it("rejects missing non-export-controlled confirmation before evaluation", async () => {
    const runBatch = vi.fn<typeof runEvaluationBatch>().mockResolvedValue([]);

    await expect(
      runFictivQuantitySweep(
        ["--quantities", "1,5"],
        { FICTIV_LIVE_TEST_CAD_PATH: "./part.step" },
        { runBatch },
      ),
    ).rejects.toThrow(/confirm-non-export-controlled/);

    expect(runBatch).not.toHaveBeenCalled();
  });
});
