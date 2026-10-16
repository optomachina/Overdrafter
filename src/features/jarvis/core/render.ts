import type { ChannelCapabilities, GraphEvent, RenderedMessage } from "./types";

export const SKIP_CHOICE = "skip";
export const NOT_AVAILABLE_REPLY = "That isn't available yet.";
export const NO_AGENT_REPLY = "I couldn't tell what kind of design this is. Try saying what you want made.";
export const RUN_FAILED_REPLY = "Something went wrong with this run. Details are on the web.";

/** The core's own acknowledgement of a submit; everything else comes from the graph. */
export type RunAcceptedEvent = { readonly type: "run_accepted"; readonly runId: string };
export type OutboundEvent = GraphEvent | RunAcceptedEvent;

function truncate(text: string, maxText: number): string {
  return text.length <= maxText ? text : `${text.slice(0, Math.max(0, maxText - 1))}…`;
}

function renderDecision(event: Extract<GraphEvent, { type: "decision_requested" }>, caps: ChannelCapabilities, link: string): RenderedMessage {
  if (caps.buttons) {
    const buttons = [...event.options.map((option) => ({ id: option, label: option })), { id: SKIP_CHOICE, label: "Skip (use best guess)" }];
    return { text: event.question, buttons };
  }
  const choices = event.options.map((option, index) => `${index + 1}. ${option}`);
  const shortcuts = [...event.options.map((_, index) => String(index + 1)), SKIP_CHOICE].join(" / ");
  const text = [event.question, ...choices, `Reply ${shortcuts}. Best guess: ${event.bestGuess}.`].join("\n");
  return { text, link };
}

function renderResolved(event: Extract<GraphEvent, { type: "decision_resolved" }>): RenderedMessage {
  if (event.outcome === "chosen") return { text: `Decision recorded: ${event.choice}.` };
  const lead = event.cause === "timeout" ? "No answer in time." : "Skipped.";
  return { text: `${lead} Going with the best guess: ${event.choice}.` };
}

function renderArtifact(event: Extract<GraphEvent, { type: "artifact" }>, caps: ChannelCapabilities, link: string): RenderedMessage {
  if (event.kind === "glb" && caps.model3d) return { text: "Your model is ready.", model3dUrl: event.uri };
  return { text: `Your ${event.kind.toUpperCase()} is ready. Open it on the web.`, link };
}

function renderResult(event: Extract<GraphEvent, { type: "result" }>, caps: ChannelCapabilities, link: string): RenderedMessage {
  const glb = caps.model3d ? event.artifacts.find((artifact) => artifact.kind === "glb") : undefined;
  return glb ? { text: `Done: ${event.summary}`, model3dUrl: glb.uri, link } : { text: `Done: ${event.summary}`, link };
}

// Error messages from the graph can carry internal detail, so channels get a fixed reply per code.
function renderError(event: Extract<GraphEvent, { type: "error" }>, link: string): RenderedMessage {
  if (event.code === "agent_not_enabled") return { text: NOT_AVAILABLE_REPLY };
  if (event.code === "no_agent") return { text: NO_AGENT_REPLY };
  return { text: RUN_FAILED_REPLY, link };
}

const CONTROL_VERB = { pause: "Pause", cancel: "Cancel" } as const;

// Control commands render in the shared thread on every channel, so each one reads as a short line.
function renderControl(event: Extract<GraphEvent, { type: `control_${string}` }>): RenderedMessage {
  if (event.type === "control_requested") return { text: `${CONTROL_VERB[event.kind]} requested.` };
  if (event.type === "control_rejected") return { text: `${CONTROL_VERB[event.kind]} rejected: ${event.reason.replace("_", " ")}.` };
  if (event.kind === "pause") return { text: "Run paused." };
  const kept = event.kept.map((artifact) => artifact.kind).join(", ");
  return { text: kept ? `Run cancelled. Kept: ${kept}.` : "Run cancelled." };
}

function renderBody(event: OutboundEvent, caps: ChannelCapabilities, link: string): RenderedMessage {
  switch (event.type) {
    case "run_accepted":
      return { text: "Got it. Working on it.", link };
    case "status":
      return { text: event.message };
    case "decision_requested":
      return renderDecision(event, caps, link);
    case "decision_resolved":
      return renderResolved(event);
    case "artifact":
      return renderArtifact(event, caps, link);
    case "result":
      return renderResult(event, caps, link);
    case "error":
      return renderError(event, link);
    case "control_requested":
    case "control_applied":
    case "control_rejected":
      return renderControl(event);
  }
}

/** Shapes an event for one channel; anything the channel cannot show degrades to text plus a web link. */
export function renderEvent(event: OutboundEvent, caps: ChannelCapabilities, webBaseUrl: string): RenderedMessage {
  const link = `${webBaseUrl}/runs/${encodeURIComponent(event.runId)}`;
  const rendered = renderBody(event, caps, link);
  return { ...rendered, text: truncate(rendered.text, caps.maxText) };
}
