import type { JsonValue } from "../choice.js";
import type { QuestionSpec, QuestionsRequest } from "../questions.js";
import type { ProjectedElement } from "./projection.js";
import type { ConfigField, DriverField, DriverOp, PageSignal, SubGoalStatus } from "./types.js";

/**
 * One request per cycle (§8). Pure. Row text lives once in `state`; element
 * criteria are `null`. A target head is sent only for an operation that has
 * at least one compatible target, and that operation is offered only then.
 */
export const OP_CRITERIA: Record<DriverOp, string> = {
  CLICK: "Press one listed control to open, reveal or dismiss what `current.field` needs, such as its dropdown or panel. Not for choosing a value.",
  FILL_REQUIRED_VALUE: "Type the required value for `current.field` into a listed editable control for that field. Code supplies the value.",
  SELECT_REQUIRED_VALUE: "Choose a listed option or radio that is marked matches_required for `current.field`.",
  WAIT: "The control `current.field` needs is missing or disabled and `page.signals` reports loading.",
  DONE: "`current.field` already shows its required value: a control for it has value_state matches_required.",
  BLOCKED: "No listed control can make progress on `current.field`: its required option is absent, an error is shown, or only unrelated controls are listed.",
};

const OP_INSTRUCTIONS = "Code is configuring one CNC part on a supplier quote page and is working only on `current.field`. "
  + "`elements` lists the only controls code allows. Code types every value and checks every result. "
  + "Labels shown as «...» are withheld page text. Which single operation should code perform next for `current.field`?";

export const TARGET_INSTRUCTIONS = {
  click_target: "If the next operation is CLICK, which element in `elements` should be pressed to open or reveal the control for `current.field`? Choose none if no listed element does that.",
  fill_target: "If the next operation is FILL_REQUIRED_VALUE, which editable element in `elements` is the input for `current.field`? Choose none if no listed element is.",
  select_target: "If the next operation is SELECT_REQUIRED_VALUE, which element in `elements` is the option for the required value of `current.field`? Choose none if no listed element is.",
} as const;
export type TargetHead = keyof typeof TARGET_INSTRUCTIONS;
export const HEAD_FOR_OP: Partial<Record<DriverOp, TargetHead>> = {
  CLICK: "click_target", FILL_REQUIRED_VALUE: "fill_target", SELECT_REQUIRED_VALUE: "select_target",
};
const CONTROL_PRESENT = "Does `elements` contain the control for `current.field`?";

export type RecentAction = { op: DriverOp; id: string | null; effect: "changed" | "no_change" | "dialog_opened" | "dialog_closed" | "listbox_opened" };

export type RequestInput = {
  current: { field: DriverField; status: SubGoalStatus; attempt: number };
  fields: Array<{ field: ConfigField; status: SubGoalStatus }>;
  signals: PageSignal[];
  dialog: string | null;
  elements: ProjectedElement[];
  recent: RecentAction[];
  /** Compatible element ids per targeted operation, already filtered by code. */
  targets: Partial<Record<DriverOp, string[]>>;
};

export type BuiltRequest = { request: QuestionsRequest; offeredOps: DriverOp[]; heads: Partial<Record<string, string[]>> };

function choice(instructions: string, keys: string[], described?: Record<string, string>): QuestionSpec {
  return { type: "choice", instructions, criteria: Object.fromEntries(keys.map((key) => [key, described?.[key] ?? null])) };
}

export function buildDriverRequest(input: RequestInput): BuiltRequest {
  const offeredOps = (["CLICK", "FILL_REQUIRED_VALUE", "SELECT_REQUIRED_VALUE", "WAIT", "DONE", "BLOCKED"] as const)
    .filter((op) => !HEAD_FOR_OP[op] || (input.targets[op]?.length ?? 0) > 0);
  const opCriteria = Object.fromEntries(offeredOps.map((op) => [op, OP_CRITERIA[op]]));
  const questions: Record<string, QuestionSpec> = {
    op: choice(OP_INSTRUCTIONS, offeredOps, opCriteria),
    // First-option bias (1.13): the same head with the options reversed; code acts only if both agree.
    op_reversed: choice(OP_INSTRUCTIONS, [...offeredOps].reverse(), opCriteria),
  };
  const heads: Partial<Record<string, string[]>> = { op: offeredOps, op_reversed: [...offeredOps].reverse() };
  for (const op of offeredOps) {
    const head = HEAD_FOR_OP[op];
    if (!head) continue;
    const keys = [...(input.targets[op] ?? []), "none"];
    questions[head] = choice(TARGET_INSTRUCTIONS[head], keys);
    heads[head] = keys;
    if (op === "CLICK" && keys.length > 3) {
      const reversed = [...keys].reverse();
      questions.click_target_r = choice(TARGET_INSTRUCTIONS.click_target, reversed);
      heads.click_target_r = reversed;
    }
  }
  questions.control_present = { type: "noul", instructions: CONTROL_PRESENT };
  const state: JsonValue = {
    task: "Configure one CNC part on a supplier quote page. Code types every value and checks every result.",
    current: input.current,
    fields: input.fields,
    page: { signals: input.signals, dialog: input.dialog },
    elements: input.elements as unknown as JsonValue,
    recent: input.recent as unknown as JsonValue,
  };
  return { request: { state, questions }, offeredOps, heads };
}
