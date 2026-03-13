import { describe, expect, it } from "vitest";
import { buildWorkspaceNotificationItems } from "./use-workspace-notifications";

describe("buildWorkspaceNotificationItems", () => {
  it("maps published package events into the client notification center slice", () => {
    const items = buildWorkspaceNotificationItems(
      [
        {
          id: "event-published",
          jobId: "job-1",
          packageId: "package-1",
          eventType: "job.quote_package_published",
          payload: null,
          occurredAt: "2026-03-13T12:00:00.000Z",
        },
      ],
      "client",
    );

    expect(items).toEqual([
      expect.objectContaining({
        id: "client.quote_package_ready:package-1",
        notificationType: "client.quote_package_ready",
        title: "Quote package ready",
        jobId: "job-1",
      }),
    ]);
  });

  it("dedupes repeated package-published events by package id", () => {
    const items = buildWorkspaceNotificationItems(
      [
        {
          id: "event-new",
          jobId: "job-1",
          packageId: "package-1",
          eventType: "job.quote_package_published",
          payload: null,
          occurredAt: "2026-03-13T12:10:00.000Z",
        },
        {
          id: "event-old",
          jobId: "job-1",
          packageId: "package-1",
          eventType: "job.quote_package_published",
          payload: null,
          occurredAt: "2026-03-13T12:00:00.000Z",
        },
      ],
      "client",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        id: "client.quote_package_ready:package-1",
        sourceEventId: "event-new",
      }),
    );
  });

  it("filters to the internal first-slice notification set for internal roles", () => {
    const items = buildWorkspaceNotificationItems(
      [
        {
          id: "event-selection",
          jobId: "job-1",
          packageId: "package-1",
          eventType: "client.quote_option_selected",
          payload: null,
          occurredAt: "2026-03-13T12:20:00.000Z",
        },
        {
          id: "event-published",
          jobId: "job-1",
          packageId: "package-1",
          eventType: "job.quote_package_published",
          payload: null,
          occurredAt: "2026-03-13T12:10:00.000Z",
        },
      ],
      "internal_estimator",
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        notificationType: "internal.client_selection_received",
        title: "Client selection received",
      }),
    );
  });
});
