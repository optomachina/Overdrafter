import { describe, expect, it } from "vitest";
import { buildActivityLogEntries, groupClientActivityEventsByJobId } from "@/features/quotes/activity-log";
import type { ClientActivityEvent } from "@/features/quotes/types";

function createEvent(input: Partial<ClientActivityEvent> & Pick<ClientActivityEvent, "id" | "jobId" | "eventType">) {
  return {
    packageId: null,
    payload: {},
    occurredAt: "2026-03-10T17:00:00.000Z",
    ...input,
  } satisfies ClientActivityEvent;
}

describe("activity log mapping", () => {
  it("maps client-safe worker and audit events into timestamped log entries", () => {
    const entries = buildActivityLogEntries([
      createEvent({
        id: "event-quote-ready",
        jobId: "job-1",
        eventType: "worker.quote_run_completed",
        occurredAt: "2026-03-10T17:33:00.000Z",
        payload: {
          successfulVendorQuotes: 2,
          failedVendorQuotes: 1,
        },
      }),
      createEvent({
        id: "event-extract",
        jobId: "job-1",
        eventType: "worker.extraction_completed",
        occurredAt: "2026-03-10T17:05:00.000Z",
        payload: {
          warningCount: 1,
        },
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        id: "event-quote-ready",
        label: "Quote responses ready",
        tone: "active",
        occurredAt: "2026-03-10T17:33:00.000Z",
      }),
      expect.objectContaining({
        id: "event-extract",
        label: "Part details extracted",
        tone: "attention",
        occurredAt: "2026-03-10T17:05:00.000Z",
      }),
    ]);
    expect(entries[0]?.detail).toContain("2 responses are ready for review");
    expect(entries[0]?.detail).toContain("1 lane could not return a usable quote");
    expect(entries[1]?.detail).toContain("1 warning");
  });

  it("groups activity rows by job id for project workspace timelines", () => {
    const events = [
      createEvent({
        id: "event-a",
        jobId: "job-a",
        eventType: "job.created",
      }),
      createEvent({
        id: "event-b",
        jobId: "job-b",
        eventType: "job.quote_package_published",
      }),
      createEvent({
        id: "event-c",
        jobId: "job-a",
        eventType: "client.part_request_updated",
      }),
    ];

    const grouped = groupClientActivityEventsByJobId(events);

    expect(grouped.get("job-a")?.map((event) => event.id)).toEqual(["event-a", "event-c"]);
    expect(grouped.get("job-b")?.map((event) => event.id)).toEqual(["event-b"]);
  });

  it("includes requested services when a part request update changes service intent", () => {
    const entries = buildActivityLogEntries([
      createEvent({
        id: "event-request-update",
        jobId: "job-1",
        eventType: "client.part_request_updated",
        payload: {
          requestedServiceKinds: ["dfm_review", "manufacturing_quote"],
          primaryServiceKind: "dfm_review",
          quantity: 12,
          requestedByDate: "2026-03-24",
        },
      }),
    ]);

    expect(entries[0]?.detail).toContain("12 units");
    expect(entries[0]?.detail).toContain("DFM review");
    expect(entries[0]?.detail).toContain("Manufacturing quote");
  });
});
