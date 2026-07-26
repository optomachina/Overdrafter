// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createSpendGuard, SpendCapExceededError, permissiveSpendGuard } from "./spendGuard.js";

function clientReturning(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as never;
}

describe("createSpendGuard.reserve", () => {
  it("returns a reservation when the ledger allows the spend", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: true, reservationId: "res-1" },
      error: null,
    });

    const reservation = await createSpendGuard(clientReturning(rpc), "org-1").reserve(
      "llm_extraction",
      0.05,
      { partId: "part-1" },
    );

    expect(reservation).toEqual({ reservationId: "res-1", estimatedUsd: 0.05 });
    expect(rpc).toHaveBeenCalledWith(
      "api_reserve_spend",
      expect.objectContaining({
        p_organization_id: "org-1",
        p_category: "llm_extraction",
        p_estimated_usd: 0.05,
      }),
    );
  });

  it("throws with the ledger's reason when a ceiling is reached", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        allowed: false,
        reasonCode: "global_daily_ceiling",
        reason: "The platform-wide daily spend ceiling has been reached.",
      },
      error: null,
    });

    const error = await createSpendGuard(clientReturning(rpc), "org-1")
      .reserve("llm_extraction", 0.05)
      .catch((caught: unknown) => caught as SpendCapExceededError);

    expect(error).toBeInstanceOf(SpendCapExceededError);
    expect((error as SpendCapExceededError).reasonCode).toBe("global_daily_ceiling");
  });

  it("refuses the spend when the kill switch is on", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { allowed: false, reasonCode: "kill_switch", reason: "halted" },
      error: null,
    });

    await expect(
      createSpendGuard(clientReturning(rpc), "org-1").reserve("vendor_automation", 1),
    ).rejects.toBeInstanceOf(SpendCapExceededError);
  });

  it("fails closed when the ledger is unreachable", async () => {
    // A guard that opens up when its own storage is down provides no guarantee,
    // and an unreachable ledger is exactly when unbounded spend is least safe.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "connection refused" } });

    const error = await createSpendGuard(clientReturning(rpc), "org-1")
      .reserve("llm_extraction", 0.05)
      .catch((caught: unknown) => caught as SpendCapExceededError);

    expect(error).toBeInstanceOf(SpendCapExceededError);
    expect((error as SpendCapExceededError).reasonCode).toBe("ledger_unavailable");
  });
});

describe("createSpendGuard.settle", () => {
  it("replaces the estimate with the observed amount", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { settled: true }, error: null });

    await createSpendGuard(clientReturning(rpc), "org-1").settle(
      { reservationId: "res-1", estimatedUsd: 0.5 },
      0.0123,
    );

    expect(rpc).toHaveBeenCalledWith(
      "api_settle_spend",
      expect.objectContaining({ p_reservation_id: "res-1", p_actual_usd: 0.0123 }),
    );
  });

  it("settles at zero when no cost was observed", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { settled: true }, error: null });

    await createSpendGuard(clientReturning(rpc), "org-1").settle(
      { reservationId: "res-1", estimatedUsd: 0.5 },
      null,
    );

    expect(rpc.mock.calls[0][1].p_actual_usd).toBe(0);
  });

  it("never negatively settles", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { settled: true }, error: null });

    await createSpendGuard(clientReturning(rpc), "org-1").settle(
      { reservationId: "res-1", estimatedUsd: 0.5 },
      -10,
    );

    expect(rpc.mock.calls[0][1].p_actual_usd).toBe(0);
  });

  it("does not throw when settlement fails", async () => {
    // The reservation already bounded the spend; failing the surrounding work
    // over a settlement error would be worse than leaving the estimate booked.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "timeout" } });

    await expect(
      createSpendGuard(clientReturning(rpc), "org-1").settle(
        { reservationId: "res-1", estimatedUsd: 0.5 },
        0.01,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("permissiveSpendGuard", () => {
  it("permits everything, for tests and offline tooling", async () => {
    const reservation = await permissiveSpendGuard.reserve("llm_extraction", 999);
    await expect(permissiveSpendGuard.settle(reservation, 999)).resolves.toBeUndefined();
  });
});
