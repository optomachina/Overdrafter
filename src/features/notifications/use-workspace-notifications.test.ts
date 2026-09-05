import { describe, expect, it } from "vitest";
import {
  buildPlatformAdminNotificationItems,
  buildWorkspaceNotificationItems,
} from "./use-workspace-notifications";

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

  it("uses quote-ready payload metadata when present for mobile review copy", () => {
    const items = buildWorkspaceNotificationItems(
      [
        {
          id: "event-published",
          jobId: "job-1",
          packageId: "package-1",
          eventType: "job.quote_package_published",
          payload: {
            optionCount: 3,
            jobReference: "QB00001",
          },
          occurredAt: "2026-03-13T12:00:00.000Z",
        },
      ],
      "client",
    );

    expect(items).toEqual([
      expect.objectContaining({
        id: "client.quote_package_ready:package-1",
        detail: "3 quotes ready for QB00001. Open Quote review on your phone to choose a vendor.",
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

describe("buildPlatformAdminNotificationItems", () => {
  const records = [
    {
      id: "provider.integration_added:quickparts:manifest-v1",
      eventType: "provider.integration_added" as const,
      providerKey: "quickparts",
      policyRevision: "manifest-v1",
      admissionState: "disabled" as const,
      genericDispatchEnabled: false as const,
      occurredAt: "2026-09-05T03:30:00.000Z",
    },
  ];

  it("shows a truthful disabled-provider notification to platform admins", () => {
    expect(buildPlatformAdminNotificationItems(records, true)).toEqual([
      expect.objectContaining({
        id: "platform.provider_added:provider.integration_added:quickparts:manifest-v1",
        notificationType: "platform.provider_added",
        title: "Quickparts added as a disabled provider",
        detail:
          "Quickparts is in the provider catalog but remains disabled pending live evaluation and production certification.",
        jobId: null,
      }),
    ]);
  });

  it("does not project provider events for non-platform admins", () => {
    expect(buildPlatformAdminNotificationItems(records, false)).toEqual([]);
  });
});
