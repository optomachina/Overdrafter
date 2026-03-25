import type { ActivityLogEntry } from "@/components/quotes/ActivityLog";
import {
  formatRequestedServiceKindLabel,
  normalizeRequestedServiceKinds,
} from "@/features/quotes/service-intent";
import type { ClientActivityEvent } from "@/features/quotes/types";

type ActivityPayload = Record<string, unknown>;

function asPayload(payload: ClientActivityEvent["payload"]): ActivityPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as ActivityPayload;
}

function readNumber(payload: ActivityPayload, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(payload: ActivityPayload, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeRequestedDate(requestedByDate: string | null): string {
  return requestedByDate ? ` Requested by ${requestedByDate}.` : "";
}

function describeRequestedServices(payload: ActivityPayload): string {
  const requestedServiceKinds = normalizeRequestedServiceKinds(
    Array.isArray(payload.requestedServiceKinds)
      ? payload.requestedServiceKinds.filter((value): value is string => typeof value === "string")
      : [],
    readString(payload, "primaryServiceKind"),
  );

  if (requestedServiceKinds.length === 0) {
    return "";
  }

  return ` Services: ${requestedServiceKinds.map((serviceKind) => formatRequestedServiceKindLabel(serviceKind)).join(", ")}.`;
}

export function groupClientActivityEventsByJobId(events: ClientActivityEvent[]): Map<string, ClientActivityEvent[]> {
  const eventsByJobId = new Map<string, ClientActivityEvent[]>();

  events.forEach((event) => {
    const current = eventsByJobId.get(event.jobId) ?? [];
    current.push(event);
    eventsByJobId.set(event.jobId, current);
  });

  return eventsByJobId;
}

export function buildActivityLogEntries(events: ClientActivityEvent[]): ActivityLogEntry[] {
  return [...events]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .map((event) => {
      const payload = asPayload(event.payload);

      switch (event.eventType) {
        case "job.created":
          return {
            id: event.id,
            label: "Part created",
            detail: "The workspace was created and is ready for file intake.",
            occurredAt: event.occurredAt,
            tone: "default",
          };
        case "job.extraction_requested":
          return {
            id: event.id,
            label: "Extraction requested",
            detail: "Attached files were queued for part detail extraction.",
            occurredAt: event.occurredAt,
            tone: "active",
          };
        case "worker.extraction_completed": {
          const warningCount = readNumber(payload, "warningCount") ?? 0;
          const extractionLifecycle = readString(payload, "extractionLifecycle");

          return {
            id: event.id,
            label: "Part details extracted",
            detail:
              extractionLifecycle === "partial"
                ? `Available drawing fields were extracted, but ${pluralize(warningCount, "warning")} still need review.`
                : warningCount > 0
                ? `Material, finish, and revision were extracted for review with ${pluralize(warningCount, "warning")}.`
                : "Material, finish, and revision were extracted and moved into review.",
            occurredAt: event.occurredAt,
            tone: warningCount > 0 ? "attention" : "active",
          };
        }
        case "worker.extraction_failed":
          return {
            id: event.id,
            label: "Extraction needs attention",
            detail: "The system could not finish reading the attached part package yet.",
            occurredAt: event.occurredAt,
            tone: "attention",
          };
        case "client.part_request_updated": {
          const quantity = readNumber(payload, "quantity");
          const requestedByDate = readString(payload, "requestedByDate");
          const serviceDetail = describeRequestedServices(payload);

          return {
            id: event.id,
            label: "Part request updated",
            detail:
              quantity === null
                ? `The request details were updated.${serviceDetail}${describeRequestedDate(requestedByDate)}`
                : `The request was updated to ${pluralize(quantity, "unit")}.${serviceDetail}${describeRequestedDate(requestedByDate)}`,
            occurredAt: event.occurredAt,
            tone: "default",
          };
        }
        case "job.requirements_approved":
          return {
            id: event.id,
            label: "Requirements approved",
            detail: "The reviewed request is ready for quote collection.",
            occurredAt: event.occurredAt,
            tone: "active",
          };
        case "job.quote_run_started":
          if (payload.clientTriggered === true) {
            return {
              id: event.id,
              label: "Quote request accepted",
              detail: "Your quote request was accepted and queued for vendor quote collection.",
              occurredAt: event.occurredAt,
              tone: "active",
            };
          }

          return {
            id: event.id,
            label: "Quote collection started",
            detail: "The system started gathering vendor responses for the current request.",
            occurredAt: event.occurredAt,
            tone: "active",
          };
        case "worker.quote_run_completed": {
          const successCount = readNumber(payload, "successfulVendorQuotes") ?? 0;
          const failedCount = readNumber(payload, "failedVendorQuotes") ?? 0;

          return {
            id: event.id,
            label: "Quote responses ready",
            detail:
              failedCount > 0
                ? `${pluralize(successCount, "response")} are ready for review and ${pluralize(failedCount, "lane")} could not return a usable quote.`
                : `${pluralize(successCount, "response")} are ready for review.`,
            occurredAt: event.occurredAt,
            tone: "active",
          };
        }
        case "worker.quote_run_attention_needed": {
          const manualCount = readNumber(payload, "manualReviewVendorQuotes") ?? 0;
          const successCount = readNumber(payload, "successfulVendorQuotes") ?? 0;

          return {
            id: event.id,
            label: "Quote review needs attention",
            detail:
              successCount > 0
                ? `${pluralize(successCount, "response")} arrived, but ${pluralize(manualCount, "lane")} still need manual follow-up before publication.`
                : `${pluralize(manualCount, "lane")} still need manual follow-up before publication.`,
            occurredAt: event.occurredAt,
            tone: "attention",
          };
        }
        case "worker.quote_run_failed":
          return {
            id: event.id,
            label: "Quote collection stalled",
            detail: "No publishable quote responses were captured yet. Internal review is required before this part can move forward.",
            occurredAt: event.occurredAt,
            tone: "attention",
          };
        case "job.quote_package_published":
          return {
            id: event.id,
            label: "Quote package published",
            detail: "Curated quote options are now available for review in this workspace.",
            occurredAt: event.occurredAt,
            tone: "active",
          };
        case "client.quote_option_selected":
          return {
            id: event.id,
            label: "Quote option selected",
            detail: "Your selection was recorded against the published quote package.",
            occurredAt: event.occurredAt,
            tone: "active",
          };
        default:
          return {
            id: event.id,
            label: "Workflow updated",
            detail: null,
            occurredAt: event.occurredAt,
            tone: "default",
          };
      }
    });
}
