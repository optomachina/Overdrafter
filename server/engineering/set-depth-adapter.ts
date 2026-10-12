import type { PreparedAdapter } from "./dispatch-prepared-request.ts";

const SCHEMA = "overdrafter.prepared-interpretation.v1";
const MIN_DEPTH_MM = 6;
const MAX_DEPTH_MM = 10;
// Closed grammar: [please] set [the] depth to N <mm>. Millimeters only; no inch conversion exists.
const SET_DEPTH = /^set (?:the )?depth to (\d{1,2}(?:\.\d{1,3})?) ?(?:mm|millimeters?|millimetres?)$/;

type Proposal = Readonly<{
  schema: typeof SCHEMA;
  outcome: "prepared_change" | "no_change";
  depthMm: number | null;
}>;

const UNSUPPORTED: Proposal = { schema: SCHEMA, outcome: "no_change", depthMm: null };

function normalized(text: string): string | null {
  if (typeof text !== "string" || text.length > 512) return null;
  const value = text.trim().toLowerCase().replace(/\s+/g, " ")
    .replace(/[.!?]$/, "").replace(/^please /, "").replace(/ please$/, "");
  return value || null;
}

/** Pure interpretation of the message text only; CAD context is never read. */
export function interpretSetDepth(text: string): Proposal {
  const message = normalized(text);
  const match = message ? SET_DEPTH.exec(message) : null;
  if (!match) return UNSUPPORTED;
  const depthMm = Number(match[1]);
  if (!Number.isFinite(depthMm) || depthMm < MIN_DEPTH_MM || depthMm > MAX_DEPTH_MM) return UNSUPPORTED;
  return { schema: SCHEMA, outcome: "prepared_change", depthMm };
}

/**
 * Deterministic adapter for the single supported intent. It uses no model and no
 * network, and ignores the prepared context bytes. The dispatcher still requires
 * its proposal to equal the retained classifier result, so a disagreement fails
 * closed as invalid_output rather than producing a different depth.
 */
export const setDepthAdapter: PreparedAdapter = async ({ text }) => interpretSetDepth(text);
