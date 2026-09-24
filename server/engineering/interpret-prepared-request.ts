import { nativeDigest, readNativeContext } from "../../src/lib/engineering-cumulative";

export type PreparedClarification = Readonly<{
  reason: "unit" | "depth";
  contextSha256: string;
  depthMm: number | null;
}>;

export type PreparedInterpretation = Readonly<{
  outcome: "prepared_change" | "needs_context" | "no_change";
  depthMm: number | null;
  response: string;
  clarification: PreparedClarification | null;
}>;

export type PreparedInterpretationInput = Readonly<{
  text: string;
  contextText: string;
  inputSnapshotId: string;
  expectedContextSha256: string;
  organizationId: string;
  projectId: string;
  priorClarification?: PreparedClarification | null;
}>;

const QUANTITY = /^((?:\d+(?:\.\d+)?|\.\d+))\s*(mm|millimeters?|millimetres?)?$/;
const DEPTH_COMMAND = /^(?:set|change|make) (?:the )?(?:baseline |extrusion )?depth(?: to)? (.+)$/;
const IT_COMMAND = /^make it (.+)$/;
const MISSING_DEPTH = /^(?:set|change) (?:the )?(?:baseline |extrusion )?depth(?: to)?$/;
const UNIT_ONLY = /^(?:mm|millimeters?|millimetres?)$/;

function noChange(response = "I can accept one absolute depth change for this prepared part. Try “Set the depth to 8 mm.”"): PreparedInterpretation {
  return { outcome: "no_change", depthMm: null, response, clarification: null };
}

function clarify(reason: PreparedClarification["reason"], contextSha256: string, depthMm: number | null): PreparedInterpretation {
  const response = reason === "unit"
    ? `Which units do you mean for ${depthMm}? This prepared part uses millimeters.`
    : "What target depth should the prepared part have? Give one value from 6 to 10 mm.";
  return { outcome: "needs_context", depthMm: null, response,
    clarification: { reason, contextSha256, depthMm } };
}

function prepared(depthMm: number): PreparedInterpretation {
  if (!Number.isFinite(depthMm) || depthMm < 6 || depthMm > 10) {
    return noChange("The target depth must be from 6 to 10 mm for this prepared part.");
  }
  return { outcome: "prepared_change", depthMm,
    response: `I recorded the request to set the prepared part depth to ${depthMm} mm. Native work has not started.`,
    clarification: null };
}

function normalized(text: string): string | null {
  if (typeof text !== "string" || text.length > 512 || new TextEncoder().encode(text).byteLength > 8000) return null;
  if (Array.from(text).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  })) return null;
  const value = text.trim().toLowerCase().replace(/\s+/g, " ")
    .replace(/[.!?]$/, "").replace(/^please /, "")
    .replace(/^(?:can|could|would) you /, "").replace(/ please$/, "");
  return value || null;
}

/**
 * Classify only the prepared v2 absolute-depth operation. Stored snapshot bytes,
 * identity, and scope are rechecked here; the caller still owns admission,
 * conversation ordering, idempotency, and native execution authority.
 */
export async function classifyPreparedDepthRequest(input: PreparedInterpretationInput): Promise<PreparedInterpretation> {
  const context = readNativeContext(input.contextText);
  const contextSha256 = await nativeDigest(input.contextText);
  if (contextSha256 !== input.expectedContextSha256 || context.snapshotId !== input.inputSnapshotId
      || context.scope.organizationId !== input.organizationId || context.scope.projectId !== input.projectId) {
    throw new TypeError("The prepared context identity changed.");
  }
  const message = normalized(input.text);
  if (!message) return noChange("Enter one short, explicit depth request, such as “Set the depth to 8 mm.”");
  if (UNIT_ONLY.test(message)) {
    const prior = input.priorClarification;
    if (prior?.reason === "unit" && prior.contextSha256 === contextSha256 && prior.depthMm !== null) {
      return prepared(prior.depthMm);
    }
    return noChange("Give the target depth and units together, such as “8 mm.” A unit alone needs a pending clarification.");
  }
  if (message === "make it thicker" || MISSING_DEPTH.test(message)) return clarify("depth", contextSha256, null);
  const command = DEPTH_COMMAND.exec(message) ?? IT_COMMAND.exec(message);
  const quantity = QUANTITY.exec(command ? command[1] : message);
  if (!quantity) return noChange();
  const depthMm = Number(quantity[1]);
  if (!Number.isFinite(depthMm) || depthMm < 6 || depthMm > 10) return prepared(depthMm);
  if (!quantity[2]) return clarify("unit", contextSha256, depthMm);
  return prepared(depthMm);
}
