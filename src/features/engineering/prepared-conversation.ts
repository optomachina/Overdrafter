import { serialize, type Workbench } from "./prepared-workflow";

export type ConversationProposal = Readonly<{
  contextSha256: string;
  depthMm: number;
  baselineDepthMm: number;
}>;

export type ConversationClarification =
  | Readonly<{ reason: "context"; contextSha256: null; depthMm: null }>
  | Readonly<{ reason: "depth"; contextSha256: string; depthMm: null }>
  | Readonly<{ reason: "unit"; contextSha256: string; depthMm: number }>;

export type ConversationReply =
  | Readonly<{ kind: "clarification"; message: string; clarification: ConversationClarification }>
  | Readonly<{ kind: "proposal"; message: string; proposal: ConversationProposal }>
  | Readonly<{ kind: "unsupported"; message: string }>;

const MAX_MESSAGE_LENGTH = 512;
const UNIT_ONLY = /^(?:mm|millimeters?|millimetres?)$/;
const QUANTITY = /^([+-]?(?:\d*\.)?\d+)\s*(mm|millimeters?|millimetres?)?$/;
const DIMENSION_COMMAND = /^(?:make|set|change) (?:it|(?:the )?(?:baseline |extrusion )?depth)(?: to)? (.+)$/;
const MISSING_DEPTH_COMMAND = /^(?:set|change) (?:the )?(?:baseline |extrusion )?depth(?: to)?$/;

function unsupported(message = "I can prepare one explicit depth change for this assembly. Try “Set the depth to 8 mm.” Other changes and ambiguous requests need a separate decision."): ConversationReply {
  return Object.freeze({ kind: "unsupported", message });
}

function ask(message: string, clarification: ConversationClarification): ConversationReply {
  return Object.freeze({ kind: "clarification", message, clarification: Object.freeze(clarification) });
}

function normalizedMessage(text: string): string | null {
  if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) return null;
  const hasControlCharacter = Array.from(text).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
  if (hasControlCharacter) return null;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.replace(/[.!?]$/, "").replace(/^please /, "").replace(/^(?:can|could|would) you /, "").replace(/ please$/, "");
}

function proposedDepth(depthMm: number, workbench: Workbench): ConversationReply {
  const proposal = Object.freeze({ contextSha256: workbench.contextSha256, depthMm, baselineDepthMm: workbench.context.dimension.baseline });
  try {
    confirmPreparedProposal(proposal, workbench);
  } catch (cause) {
    return unsupported(cause instanceof Error ? cause.message : "This change cannot be prepared against the current context.");
  }
  return Object.freeze({
    kind: "proposal",
    message: `Prepare a private candidate with the baseline depth changed from ${proposal.baselineDepthMm} to ${depthMm} mm? Confirm the decision below to save an evaluation request.`,
    proposal,
  });
}

function answerUnits(message: string, workbench: Workbench, clarification: ConversationClarification | null): ConversationReply {
  if (clarification?.reason !== "unit" || clarification.contextSha256 !== workbench.contextSha256 || !Number.isFinite(clarification.depthMm)) {
    return unsupported("Please give the target depth with its units, such as “8 mm.” A unit alone needs a pending number from this assembly context.");
  }
  if (!UNIT_ONLY.test(message)) return unsupported();
  return proposedDepth(clarification.depthMm, workbench);
}

/**
 * Interprets a closed set of local dimension phrases, never general engineering
 * reasoning. It cannot queue work, infer missing units, or report CAD progress.
 * Only a bare unit answer may reuse an explicitly supplied pending number.
 */
export function interpretPreparedMessage(
  text: string,
  workbench: Workbench | null,
  clarification: ConversationClarification | null = null,
): ConversationReply {
  const message = normalizedMessage(text);
  if (!message) return unsupported("Enter one short depth request, up to 512 characters, such as “Set the depth to 8 mm.”");
  if (!workbench) {
    return ask("Import the prepared assembly context first. Then tell me the target depth and units.", { reason: "context", contextSha256: null, depthMm: null });
  }
  if (UNIT_ONLY.test(message)) return answerUnits(message, workbench, clarification);
  if (message === "make it thicker" || MISSING_DEPTH_COMMAND.test(message)) {
    return ask("What target depth should the baseline part have? Give one value from 6 to 10 mm, such as “8 mm.”", { reason: "depth", contextSha256: workbench.contextSha256, depthMm: null });
  }
  const command = DIMENSION_COMMAND.exec(message);
  const quantity = QUANTITY.exec(command ? command[1] : message);
  if (!quantity) return unsupported();
  const value = Number(quantity[1]);
  if (!Number.isFinite(value)) return unsupported("The target depth must be a finite number from 6 to 10 mm.");
  if (!quantity[2]) {
    return ask(`Which units do you mean for ${value}? This prepared dimension supports millimeters.`, { reason: "unit", contextSha256: workbench.contextSha256, depthMm: value });
  }
  return proposedDepth(value, workbench);
}

/**
 * Rechecks a proposal against validated current context at explicit confirmation.
 * Returning the depth does not accept intent or dispatch CAD; the caller must
 * separately queue and persist the resulting prepared-workflow record.
 */
export function confirmPreparedProposal(proposal: ConversationProposal, workbench: Workbench): number {
  // Reuse the existing model's runtime trust check without changing its state.
  serialize(workbench);
  if (!proposal || Object.getPrototypeOf(proposal) !== Object.prototype || Object.keys(proposal).length !== 3 || !["contextSha256", "depthMm", "baselineDepthMm"].every((key) => Object.prototype.hasOwnProperty.call(proposal, key))) {
    throw new TypeError("The proposed change is malformed. Submit the request again.");
  }
  if (proposal.contextSha256 !== workbench.contextSha256) {
    throw new TypeError("The assembly context changed. Submit the request again before confirming.");
  }
  const dimension = workbench.context.dimension;
  if (proposal.baselineDepthMm !== dimension.baseline) {
    throw new TypeError("The baseline depth changed. Submit the request again before confirming.");
  }
  if (dimension.id !== "baseline-depth" || dimension.unit !== "mm" || dimension.minimum !== 6 || dimension.maximum !== 10 || dimension.baseline !== 5) {
    throw new TypeError("This prepared assembly dimension is not supported.");
  }
  if (typeof proposal.depthMm !== "number" || !Number.isFinite(proposal.depthMm) || proposal.depthMm < dimension.minimum || proposal.depthMm > dimension.maximum) {
    throw new TypeError("The target depth must be a finite number from 6 to 10 mm.");
  }
  return proposal.depthMm;
}
