import type { ChannelCapabilities, GraphEvent, RenderedMessage } from "./types";

export const SKIP_CHOICE = "skip";

function truncate(text: string, maxText: number): string {
  return text.length <= maxText ? text : `${text.slice(0, Math.max(0, maxText - 1))}…`;
}

function renderDecision(event: Extract<GraphEvent, { type: "decision_requested" }>, caps: ChannelCapabilities, link: string): RenderedMessage {
  if (caps.buttons) {
    const buttons = [...event.options, { id: SKIP_CHOICE, label: "Skip (use best guess)" }];
    return { text: event.question, buttons };
  }
  const choices = event.options.map((option, index) => `${index + 1}. ${option.label}`);
  const shortcuts = [...event.options.map((_, index) => String(index + 1)), SKIP_CHOICE].join(" / ");
  const text = [event.question, ...choices, `Reply ${shortcuts}. Best guess: ${event.bestGuess}.`].join("\n");
  return { text, link };
}

function renderArtifact(event: Extract<GraphEvent, { type: "artifact" }>, caps: ChannelCapabilities, link: string): RenderedMessage {
  if (event.format === "glb" && caps.model3d) return { text: "Your model is ready.", model3dUrl: event.url };
  return { text: `Your ${event.format.toUpperCase()} is ready. Open it on the web.`, link };
}

function renderBody(event: GraphEvent, caps: ChannelCapabilities, link: string): RenderedMessage {
  switch (event.type) {
    case "run_accepted":
      return { text: "Got it. Working on it.", link };
    case "decision_requested":
      return renderDecision(event, caps, link);
    case "decision_resolved":
      return event.resolution === "chosen"
        ? { text: `Decision recorded: ${event.chosen}.` }
        : { text: `Skipped. Going with the best guess: ${event.chosen}.` };
    case "artifact":
      return renderArtifact(event, caps, link);
    case "status":
      return { text: event.text };
    case "notice":
      return { text: event.text };
  }
}

/** Shapes a graph event for one channel; anything the channel cannot show degrades to text plus a web link. */
export function renderEvent(event: GraphEvent, caps: ChannelCapabilities, webBaseUrl: string): RenderedMessage {
  const link = "runId" in event ? `${webBaseUrl}/runs/${encodeURIComponent(event.runId)}` : webBaseUrl;
  const rendered = renderBody(event, caps, link);
  return { ...rendered, text: truncate(rendered.text, caps.maxText) };
}
