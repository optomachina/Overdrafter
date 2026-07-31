import { describe, expect, it } from "vitest";
import {
  clientWorkspaceItemsNeedPolling,
  shouldPollClientWorkspaceState,
} from "@/features/quotes/client-workspace-polling";

describe("client workspace polling", () => {
  it.each(["queued", "extracting", "uploaded"])(
    "polls while extraction is %s",
    (extractionLifecycle) => {
      expect(
        shouldPollClientWorkspaceState({
          extractionLifecycle,
          quoteRequestStatus: "received",
        }),
      ).toBe(true);
    },
  );

  it.each(["queued", "requesting"])(
    "polls while a quote request is %s",
    (quoteRequestStatus) => {
      expect(
        shouldPollClientWorkspaceState({
          extractionLifecycle: "complete",
          quoteRequestStatus,
        }),
      ).toBe(true);
    },
  );

  it("does not poll indefinitely for a manual quote request awaiting human review", () => {
    expect(
      shouldPollClientWorkspaceState({
        extractionLifecycle: "complete",
        quoteRequestStatus: "queued",
        quoteRequestMode: "manual",
      }),
    ).toBe(false);
  });

  it.each(["received", "failed", "canceled"])(
    "stops after the quote request is %s",
    (quoteRequestStatus) => {
      expect(
        shouldPollClientWorkspaceState({
          extractionLifecycle: "complete",
          quoteRequestStatus,
        }),
      ).toBe(false);
    },
  );

  it("keeps polling briefly when receipt publishes before its offer is visible", () => {
    expect(
      shouldPollClientWorkspaceState({
        extractionLifecycle: "complete",
        quoteRequestStatus: "received",
        quoteRequestUpdatedAt: "2026-07-30T12:00:00.000Z",
        hasPersistedOffers: false,
        nowMs: new Date("2026-07-30T12:00:30.000Z").getTime(),
      }),
    ).toBe(true);
  });

  it("stops the receipt grace poll after an offer arrives or the window expires", () => {
    const common = {
      extractionLifecycle: "complete",
      quoteRequestStatus: "received",
      quoteRequestUpdatedAt: "2026-07-30T12:00:00.000Z",
      nowMs: new Date("2026-07-30T12:01:00.000Z").getTime(),
    };

    expect(
      shouldPollClientWorkspaceState({
        ...common,
        hasPersistedOffers: false,
      }),
    ).toBe(false);
    expect(
      shouldPollClientWorkspaceState({
        ...common,
        hasPersistedOffers: true,
      }),
    ).toBe(false);
  });

  it("polls a project when any workspace item still has active quote work", () => {
    const items = [
      {
        part: { clientExtraction: { lifecycle: "complete" } },
        latestQuoteRequest: { status: "received", request_mode: "automatic" },
      },
      {
        part: { clientExtraction: { lifecycle: "complete" } },
        latestQuoteRequest: { status: "requesting", request_mode: "automatic" },
      },
    ];

    expect(clientWorkspaceItemsNeedPolling(items)).toBe(true);
  });
});
