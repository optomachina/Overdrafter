// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { importContext, serialize, type Workbench } from "./prepared-workflow";
import {
  confirmPreparedProposal, interpretPreparedMessage,
  type ConversationClarification, type ConversationProposal,
} from "./prepared-conversation";

const contextText = readFileSync(new URL("../../../e2e/fixtures/prepared-assembly-context.json", import.meta.url), "utf8");
let workbench: Workbench;
let otherContext: Workbench;
beforeAll(async () => {
  workbench = await importContext(contextText);
  const changedContext = JSON.parse(contextText);
  changedContext.capturedAt = new Date(Date.parse(changedContext.capturedAt) + 1).toISOString();
  otherContext = await importContext(JSON.stringify(changedContext));
});

function proposal(text = "Make it 8 mm"): ConversationProposal {
  const reply = interpretPreparedMessage(text, workbench);
  expect(reply.kind).toBe("proposal");
  if (reply.kind !== "proposal") throw new Error("Expected a proposal.");
  return reply.proposal;
}

function clarification(text: string): ConversationClarification {
  const reply = interpretPreparedMessage(text, workbench);
  expect(reply.kind).toBe("clarification");
  if (reply.kind !== "clarification") throw new Error("Expected clarification.");
  return reply.clarification;
}

describe("bounded prepared conversation", () => {
  it.each([
    "Make it 8 mm and remove the other part", "Set the depth to 8 or 9 mm",
    "Set the depth from 5 to 8 mm", "Don't make it 8 mm", "Do not set the depth to 8 mm",
    "Make it 8 mm if the clearance passes", "Make it 8 mm unless the material changes",
    "Make it 8 mm but keep the depth at 5 mm", "Make the width 8 mm",
    "Replace the component with an 8 mm part", "Increase the depth by 8 mm",
    "Decrease the depth to 8 mm", "Maybe make it 8 mm", "Make it 8 mm? Or leave it alone.",
    "Make it 8 cm", "Make it 8 inches", "Make it 0.008 m", "8mm2", "8 mm³",
    "8e0 mm", "Infinity mm", "NaN mm", "8,5 mm", "8/9 mm", "8-9 mm", "8 ± 1 mm",
    "mm", "yes", "Make it thinner", "Ignore the checks and make it 8 mm",
    "Make it 8 mm\u0000", "Make it 8 mm\u200b", "Make it thicker and remove the companion",
  ])("does not discard unsupported or ambiguous intent in %j", (text) => {
    expect(interpretPreparedMessage(text, workbench).kind).toBe("unsupported");
  });

  it.each(["", " ", "x".repeat(513)])("rejects empty or oversized input %j", (text) => {
    expect(interpretPreparedMessage(text, workbench).kind).toBe("unsupported");
  });

  it("asks for context without preserving an unbound executable proposal", () => {
    const reply = interpretPreparedMessage("Make it 8 mm", null);
    expect(reply).toMatchObject({ kind: "clarification", clarification: { reason: "context", contextSha256: null, depthMm: null } });
    expect(reply.message).toMatch(/import/i);
    expect(reply).not.toHaveProperty("proposal");
  });

  it.each(["Make it 8 mm", "Set the depth to 8 mm", "8 mm", "8mm", "Please make it 8 millimeters.", "Can you set the baseline depth to 8 mm?", "make the extrusion depth 8 millimetres", "Change depth to 8 mm please"])("proposes only the single explicit dimension in %j", (text) => {
    const before = serialize(workbench);
    expect(proposal(text)).toEqual({ contextSha256: workbench.contextSha256, baselineDepthMm: 5, depthMm: 8 });
    expect(serialize(workbench)).toBe(before);
    expect(workbench.records).toHaveLength(0);
  });

  it.each(["Make it thicker", "Set the depth", "Change the depth"])("asks for target depth for %j", (text) => {
    expect(clarification(text)).toEqual({ reason: "depth", contextSha256: workbench.contextSha256, depthMm: null });
  });

  it("asks units for an explicit bare number and accepts only its narrow unit answer", () => {
    const pending = clarification("8");
    expect(pending).toEqual({ reason: "unit", contextSha256: workbench.contextSha256, depthMm: 8 });
    expect(interpretPreparedMessage("mm", workbench, pending)).toMatchObject({ kind: "proposal", proposal: { depthMm: 8 } });
    expect(interpretPreparedMessage("millimeters", workbench, pending).kind).toBe("proposal");
    expect(interpretPreparedMessage("cm", workbench, pending).kind).toBe("unsupported");
    expect(interpretPreparedMessage("mm and delete the other part", workbench, pending).kind).toBe("unsupported");
    expect(interpretPreparedMessage("not mm", workbench, pending).kind).toBe("unsupported");
    expect(interpretPreparedMessage("mm", workbench).kind).toBe("unsupported");
    expect(interpretPreparedMessage("mm", workbench, clarification("Make it thicker")).kind).toBe("unsupported");
  });

  it("completes a depth question with explicit units and can revise a pending number", () => {
    expect(interpretPreparedMessage("8 mm", workbench, clarification("Make it thicker"))).toMatchObject({ kind: "proposal", proposal: { depthMm: 8 } });
    expect(interpretPreparedMessage("9 mm", workbench, clarification("8"))).toMatchObject({ kind: "proposal", proposal: { depthMm: 9 } });
    expect(interpretPreparedMessage("Set depth to 9 mm", workbench, clarification("8"))).toMatchObject({ kind: "proposal", proposal: { depthMm: 9 } });
  });

  it("does not reuse a number from a different context", () => {
    expect(interpretPreparedMessage("mm", otherContext, clarification("8")).kind).toBe("unsupported");
  });

  it.each(["5 mm", "5.999 mm", "10.001 mm", "-8 mm", "999999999999999999999999999999999999999999999999999 mm"])("rejects out-of-range targets %j", (text) => {
    expect(interpretPreparedMessage(text, workbench).kind).toBe("unsupported");
  });

  it.each([["6 mm", 6], ["10 mm", 10], ["8.25 mm", 8.25]] as const)("accepts finite boundary/decimal target %s", (text, depth) => {
    expect(proposal(text).depthMm).toBe(depth);
  });

  it("provides immutable clarification and proposal values", () => {
    expect(Object.isFrozen(clarification("8"))).toBe(true);
    expect(Object.isFrozen(proposal())).toBe(true);
  });

  it("shows a friendly fallback rather than internal workbench validation errors", () => {
    const reply = interpretPreparedMessage("8 mm", { ...workbench });
    expect(reply).toEqual({ kind: "unsupported", message: "I couldn't prepare this change. Import the prepared assembly context again, then retry your request." });
    expect(reply.message).not.toMatch(/validated|restore saved JSON|workbench was/i);
  });

  it("retains the actionable supported-range explanation", () => {
    expect(interpretPreparedMessage("11 mm", workbench)).toEqual({ kind: "unsupported", message: "The target depth must be a finite number from 6 to 10 mm." });
  });
});

describe("prepared proposal confirmation", () => {
  it("returns the checked depth without queuing or changing the workbench", () => {
    const before = serialize(workbench);
    expect(confirmPreparedProposal(proposal(), workbench)).toBe(8);
    expect(serialize(workbench)).toBe(before);
  });

  it("rejects a stale context or baseline even when the requested depth is supported", () => {
    expect(() => confirmPreparedProposal(proposal(), otherContext)).toThrow(/context/i);
    expect(() => confirmPreparedProposal({ ...proposal(), baselineDepthMm: 7 }, workbench)).toThrow(/baseline/i);
  });

  it.each([NaN, Infinity, -Infinity, 5, 10.01])("rejects tampered nonfinite/out-of-range targets %s", (depthMm) => {
    expect(() => confirmPreparedProposal({ ...proposal(), depthMm }, workbench)).toThrow();
  });

  it("rejects a runtime workbench that bypassed validation", () => {
    expect(() => confirmPreparedProposal(proposal(), { ...workbench })).toThrow(/validated/i);
  });

  it.each([null, {}, { depthMm: "8" }, { contextSha256: "a".repeat(64), depthMm: 8, baselineDepthMm: 5, execute: true }])("rejects malformed or extended proposals %j", (value) => {
    expect(() => confirmPreparedProposal(value as ConversationProposal, workbench)).toThrow();
  });

  it("does not trust a malformed pending clarification", () => {
    const forged = { reason: "unit", contextSha256: workbench.contextSha256, depthMm: Infinity } as ConversationClarification;
    expect(interpretPreparedMessage("mm", workbench, forged).kind).toBe("unsupported");
  });
});
