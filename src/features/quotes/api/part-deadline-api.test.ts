import { describe, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("./shared/rpc", () => ({ callRpc: rpcMock }));

import { fetchPartDeadline, parsePartDeadline, toPanelDeadline } from "./part-deadline-api";

describe("parsePartDeadline", () => {
  it("returns the confirmed active deadline", () => {
    expect(parsePartDeadline({ partId: "p", revision: "A", recordedDate: "2026-10-22", activeDate: "2026-10-22", state: "confirmed" }))
      .toEqual({ partId: "p", revision: "A", recordedDate: "2026-10-22", activeDate: "2026-10-22", state: "confirmed" });
  });

  it("never treats an inferred or expired date as active", () => {
    expect(parsePartDeadline({ partId: "p", recordedDate: "2026-10-22", activeDate: "2026-10-22", state: "inferred" }).activeDate).toBeNull();
    expect(parsePartDeadline({ partId: "p", recordedDate: "2026-09-01", activeDate: null, state: "expired" }))
      .toMatchObject({ activeDate: null, state: "expired" });
  });

  it("fails closed to inferred when a confirmed state has no valid date", () => {
    expect(parsePartDeadline({ partId: "p", activeDate: "not-a-date", state: "confirmed" }))
      .toMatchObject({ activeDate: null, state: "inferred" });
  });

  it("rejects a malformed payload", () => {
    expect(() => parsePartDeadline(null)).toThrow(TypeError);
    expect(() => parsePartDeadline({ state: "confirmed" })).toThrow(TypeError);
  });
});

describe("fetchPartDeadline", () => {
  it("reads the OVD-570 RPC for the part", async () => {
    rpcMock.mockResolvedValueOnce({ data: { partId: "p", activeDate: "2026-10-22", recordedDate: "2026-10-22", state: "confirmed", revision: "A" }, error: null });
    await expect(fetchPartDeadline("p")).resolves.toMatchObject({ activeDate: "2026-10-22" });
    expect(rpcMock).toHaveBeenCalledWith("api_get_part_deadline", { p_part_id: "p" });
  });

  it("surfaces access errors", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "part_deadline_access_denied" } });
    await expect(fetchPartDeadline("p")).rejects.toMatchObject({ message: "part_deadline_access_denied" });
  });
});

describe("toPanelDeadline", () => {
  const base = { partId: "p", revision: null };

  it("keeps the recorded date of an expired deadline so the panel can label it expired", () => {
    expect(toPanelDeadline({ ...base, recordedDate: "2026-09-01", activeDate: null, state: "expired" }))
      .toEqual({ date: "2026-09-01", state: "expired" });
  });

  it("uses the active date when confirmed and no date for an inferred deadline", () => {
    expect(toPanelDeadline({ ...base, recordedDate: "2026-10-22", activeDate: "2026-10-22", state: "confirmed" }))
      .toEqual({ date: "2026-10-22", state: "confirmed" });
    expect(toPanelDeadline({ ...base, recordedDate: "2026-10-22", activeDate: null, state: "inferred" }))
      .toEqual({ date: null, state: "inferred" });
    expect(toPanelDeadline(null)).toBeNull();
  });
});
