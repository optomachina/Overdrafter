/**
 * One request per cycle (docs/jev-quote-driver.md §8): an operation head and
 * its reversed copy, speculative target heads holding only code-filtered
 * compatible elements (null criteria; row text lives once in `state`), and a
 * `control_present` noul. Pure.
 */
import type { QuestionsRequest, QuestionSpec } from "../questions.js";
import type { DriverOp } from "./policy.js";
import type { DriverField, ProjectedElement } from "./projection.js";

export type FieldStatus = { field: DriverField; status: "pending" | "verified" };

export type CycleContext = {
  current: { field: DriverField; goal: string; attempt: number };
  fields: FieldStatus[];
  signals: string[];
  dialog: string | null;
  elements: ProjectedElement[];
  recent: Array<{ op: string; field: DriverField; effect: string }>;
};

export type Candidates = { click: string[]; fill: string[]; select: string[] };

export type BuiltCycleRequest = {
  request: QuestionsRequest;
  offeredOps: DriverOp[];
  heads: { click: string[]; fill: string[]; select: string[] };
  reversedClickHead: boolean;
};

const TASK = "Configure one CNC part on a supplier quote page. Code types every value, checks every result, and never lets you buy, upload or submit.";

const OP_TEXT: Record<DriverOp, string> = {
  CLICK: "Press one listed control (a button, a tab, or a dropdown opener) to open, reveal, confirm or dismiss what current.field needs, for example a tab or panel that may hold its control, or the button that closes something covering it. Not for choosing a value.",
  FILL_REQUIRED_VALUE: "Put the required value for current.field into one listed editable control whose value_state is not matches_required. Code types the value.",
  SELECT_REQUIRED_VALUE: "Choose one listed option marked matches_required: true for current.field.",
  WAIT: "The control current.field needs is missing or disabled AND page.signals contains loading or pricing_in_progress.",
  DONE: "The control for current.field already shows the required value (value_state is matches_required).",
  BLOCKED: "No listed control can make progress on current.field: the required option is absent, an error is shown, or only unrelated controls are listed and no listed tab or button could reveal the needed control.",
};

const OP_INSTRUCTIONS = "Choose the single next operation for current.field. `elements` lists every usable control on the page; names in «» are hidden text. "
  + "value_state and matches_required are computed by code against the requirement. occluded means another layer covers the control; "
  + "covering_layer marks controls inside that covering layer. Decide from roles, names, near labels and states, never from page wording.";

export const FIELD_GOALS: Record<DriverField, string> = {
  panel: "open the part configuration editor (it holds the process, material, finish and quantity controls)",
  dialog: "answer the open dialog so configuration can continue; code has already chosen any value inside it",
  overlay: "close or dismiss the layer that covers the page (elements marked covering_layer) so the covered controls can be used",
  process: "the process control must show the required process",
  material: "the material control must show the required material",
  finish: "the finish control (it may sit under a post processing tab) must show the required finish",
  quantity: "the quantity control must hold the required quantity",
  save: "save the part configuration",
};

function choice(instructions: string, keys: string[], reversed = false): QuestionSpec {
  const ordered = reversed ? [...keys].reverse() : keys;
  return { type: "choice", instructions, criteria: Object.fromEntries(ordered.map((key) => [key, null])) };
}

export function buildCycleRequest(context: CycleContext, candidates: Candidates): BuiltCycleRequest {
  const offeredOps: DriverOp[] = [];
  if (candidates.click.length) offeredOps.push("CLICK");
  if (candidates.fill.length) offeredOps.push("FILL_REQUIRED_VALUE");
  if (candidates.select.length) offeredOps.push("SELECT_REQUIRED_VALUE");
  offeredOps.push("WAIT");
  // DONE is a proposal code re-verifies; panel and dialog are verified structurally, so it is not offered there.
  if (!["panel", "dialog", "overlay"].includes(context.current.field)) offeredOps.push("DONE");
  offeredOps.push("BLOCKED");
  const opCriteria = Object.fromEntries(offeredOps.map((op) => [op, OP_TEXT[op]]));
  const reversedCriteria = Object.fromEntries([...offeredOps].reverse().map((op) => [op, OP_TEXT[op]]));
  const questions: QuestionsRequest["questions"] = {
    op: { type: "choice", instructions: OP_INSTRUCTIONS, criteria: opCriteria },
    op_reversed: { type: "choice", instructions: OP_INSTRUCTIONS, criteria: reversedCriteria },
  };
  const target = (op: string, purpose: string) =>
    `Assume the next operation is ${op}. Which element id in \`elements\` should it use ${purpose} for current.field? Choose none if no listed element fits.`;
  const click = [...candidates.click, "none"];
  const fill = [...candidates.fill, "none"];
  const select = [...candidates.select, "none"];
  let reversedClickHead = false;
  if (candidates.click.length) {
    questions.click_target = choice(target("CLICK", "to open, reveal or dismiss what is needed"), click);
    if (candidates.click.length >= 3) {
      questions.click_target_r = choice(target("CLICK", "to open, reveal or dismiss what is needed"), click, true);
      reversedClickHead = true;
    }
  }
  if (candidates.fill.length) questions.fill_target = choice(target("FILL_REQUIRED_VALUE", "as the editable control that takes the required value"), fill);
  if (candidates.select.length) questions.select_target = choice(target("SELECT_REQUIRED_VALUE", "as the option to choose"), select);
  questions.control_present = { type: "noul", instructions: "Does `elements` contain the editable control for current.field (not merely a button that opens it)?" };
  const state = {
    task: TASK,
    current: { field: context.current.field, goal: context.current.goal, status: "pending", attempt: context.current.attempt },
    fields: context.fields,
    page: { signals: context.signals, dialog: context.dialog },
    elements: context.elements,
    recent: context.recent.slice(-4),
  };
  return { request: { state, questions }, offeredOps, heads: { click, fill, select }, reversedClickHead };
}

export function buildSaveRequest(elements: ProjectedElement[], candidates: string[], signals: string[]) {
  const keys = [...candidates, "none"];
  const instructions = "Every configuration field is already correct. Which element id in `elements` is the button that saves or applies the part configuration? "
    + "Choose none if no listed button saves it. Never choose a button that orders, pays, uploads, discards or cancels.";
  const request: QuestionsRequest = {
    state: { task: TASK, current: { field: "save", goal: FIELD_GOALS.save }, page: { signals }, elements },
    questions: {
      save_target: choice(instructions, keys),
      save_target_r: choice(instructions, keys, true),
    },
  };
  return { request, keys };
}

export function buildOverlayRequest(elements: ProjectedElement[], candidates: string[], layer: string) {
  const questions: QuestionsRequest["questions"] = {};
  for (const id of candidates) {
    questions[`dismiss_${id}`] = {
      type: "noul",
      instructions: `A layer named ${layer} (see covering_layer.name) covers controls on the page; its own buttons are marked covering_layer. Does pressing element ${id} in \`elements\` answer or dismiss that layer so it goes away, without choosing any part, material, quantity or order setting?`,
    };
  }
  const request: QuestionsRequest = { state: { task: TASK, current: { field: "overlay", goal: FIELD_GOALS.overlay }, covering_layer: { name: layer }, elements }, questions };
  return { request };
}
