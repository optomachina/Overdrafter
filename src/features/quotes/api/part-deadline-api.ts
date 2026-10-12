import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

/** State of the persisted part deadline intent (OVD-570 `api_get_part_deadline`). */
export type PartDeadlineState = "confirmed" | "inferred" | "expired";

export type PartDeadline = {
  partId: string;
  revision: string | null;
  /** Date currently recorded on the approved requirement, confirmed or not. */
  recordedDate: string | null;
  /** Confirmed, unexpired deadline that provider scopes may use; null otherwise. */
  activeDate: string | null;
  state: PartDeadlineState;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function optionalDate(value: unknown): string | null {
  return typeof value === "string" && ISO_DATE.test(value) ? value : null;
}

/** Parses the RPC payload strictly; anything unexpected fails closed to an unconfirmed deadline. */
export function parsePartDeadline(value: unknown): PartDeadline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The part deadline response is unavailable.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.partId !== "string") {
    throw new TypeError("The part deadline response is unavailable.");
  }
  const state: PartDeadlineState = record.state === "confirmed" || record.state === "expired" ? record.state : "inferred";
  const activeDate = optionalDate(record.activeDate);
  return {
    partId: record.partId,
    revision: typeof record.revision === "string" ? record.revision : null,
    recordedDate: optionalDate(record.recordedDate),
    activeDate: state === "confirmed" ? activeDate : null,
    state: state === "confirmed" && activeDate === null ? "inferred" : state,
  };
}

export async function fetchPartDeadline(partId: string): Promise<PartDeadline> {
  const { data, error } = await callRpc("api_get_part_deadline", { p_part_id: partId });
  return parsePartDeadline(ensureData(data, error));
}

/**
 * Deadline for the comparison panel. An expired confirmed deadline has no active
 * date, so surface its recorded date to let the panel label it expired instead
 * of treating it as an unconfirmed one.
 */
export function toPanelDeadline(deadline: PartDeadline | null): { date: string | null; state: PartDeadlineState } | null {
  if (!deadline) {
    return null;
  }
  return {
    date: deadline.activeDate ?? (deadline.state === "expired" ? deadline.recordedDate : null),
    state: deadline.state,
  };
}
