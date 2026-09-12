import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineeringTaskStatus } from "./EngineeringTaskStatus";

const query = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: query.from, rpc: query.rpc } }));
const props = { conversationId: "conversation", organizationId: "organization", projectId: "project", ownerId: "owner" };
const task = { id: "10000000-0000-4000-8000-000000000001", execution_state: "running", verification_state: "unverified", adoption_state: "unadopted", engineering_decisions: { sequence: 7 }, task_execution: [] };
const rowScope = { conversation_id: props.conversationId, organization_id: props.organizationId, project_id: props.projectId, owner_user_id: props.ownerId };
const attempt = { ...rowScope, id: "10000000-0000-4000-8000-000000000002", task_id: task.id, phase: "awaiting_result" };
const execution = { ...rowScope, task_id: task.id, current_attempt_id: attempt.id, current_attempt: attempt };
const taskWithAttempt = { ...task, task_execution: [execution] };
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  for (const name of ["from", "select", "eq", "order", "limit"] as const) query[name].mockReturnValue(query);
  query.abortSignal.mockResolvedValue({ data: [task], error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); expect(query.rpc).not.toHaveBeenCalled(); });

describe("accepted engineering change observations", () => {
  it("reads only the current owner/scope and displays execution, verification and adoption independently", async () => {
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(query.from).toHaveBeenCalledExactlyOnceWith("engineering_tasks");
    expect(query.select).toHaveBeenCalledTimes(1);
    expect(query.select.mock.calls[0][0].replace(/\s/g, "")).toBe("id,execution_state,verification_state,adoption_state,engineering_decisions!inner(sequence),task_execution:engineering_task_execution!engineering_task_execution_task_id_conversation_id_organiz_fkey(task_id,conversation_id,organization_id,project_id,owner_user_id,current_attempt_id,current_attempt:engineering_execution_attempts!engineering_task_execution_current_attempt_id_task_id_fkey(id,task_id,conversation_id,organization_id,project_id,owner_user_id,phase))");
    for (const pair of [["conversation_id", props.conversationId], ["organization_id", props.organizationId], ["project_id", props.projectId], ["owner_user_id", props.ownerId], ["adoption_state", "unadopted"]]) expect(query.eq).toHaveBeenCalledWith(...pair);
    expect(query.limit).toHaveBeenCalledWith(25);
    expect(query.order.mock.calls).toEqual([["created_at", { ascending: false }], ["id", { ascending: false }]]);
    const change = screen.getByRole("article", { name: "Change 7" });
    expect(within(change).getByText("Running")).toBeVisible();
    expect(within(change).getByText("Unverified")).toBeVisible();
    expect(within(change).getByText("Not adopted")).toBeVisible();
    expect(within(change).getByText("No current attempt recorded")).toBeVisible();
    query.abortSignal.mockResolvedValue({ data: [{ ...task, execution_state: "succeeded", verification_state: "checking" }], error: null });
    await advance(5000);
    expect(within(change).getByText("Succeeded")).toBeVisible();
    expect(within(change).getByText("Checking")).toBeVisible();
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
  });

  it("follows the current attempt into awaiting results and recovery without implying verification", async () => {
    query.abortSignal.mockResolvedValue({ data: [taskWithAttempt], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    const change = screen.getByRole("article", { name: "Change 7" });
    expect(within(change).getByText("Awaiting results")).toBeVisible();
    expect(within(change).getByText("Result verification is pending.")).toBeVisible();
    expect(within(change).getByText("Running", { exact: true })).toBeVisible();
    expect(within(change).getByText("Unverified")).toBeVisible();
    expect(within(change).getByText("Not adopted")).toBeVisible();
    query.abortSignal.mockResolvedValue({ data: [{ ...taskWithAttempt, execution_state: "failed",
      task_execution: [{ ...execution, current_attempt: { ...attempt, phase: "recovery_required" } }] }], error: null });
    await advance(5000);
    expect(within(change).getByText("Recovery required")).toBeVisible();
    expect(within(change).getByText(/Execution needs reconciliation/)).toBeVisible();
    expect(within(change).getByText("Failed", { exact: true })).toBeVisible();
    expect(within(change).getByText("Unverified")).toBeVisible();
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(query.from.mock.calls.every(([table]) => table === "engineering_tasks")).toBe(true);
  });

  it.each([
    ["claimed", "Claimed"], ["running", "Active"], ["awaiting_result", "Awaiting results"],
    ["failed", "Attempt failed"], ["recovery_required", "Recovery required"],
  ])("observes phase %s without deriving task or verification state", async (phase, label) => {
    query.abortSignal.mockResolvedValue({ data: [{ ...taskWithAttempt,
      task_execution: [{ ...execution, current_attempt: { ...attempt, phase } }] }], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(screen.getByText(label, { exact: true })).toBeVisible();
    expect(screen.getByText("Running", { exact: true })).toBeVisible();
    expect(screen.getByText("Unverified")).toBeVisible();
    expect(screen.getByText("Not adopted")).toBeVisible();
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
  });

  it.each([
    { taskExecution: [] }, { taskExecution: [{ ...execution, current_attempt_id: null, current_attempt: null }] },
  ])("represents valid absence neutrally: %j", async ({ taskExecution }) => {
    query.abortSignal.mockResolvedValue({ data: [{ ...task, task_execution: taskExecution }], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(screen.getByText("No current attempt recorded")).toBeVisible();
    expect(screen.getByText("Latest observed change states.")).toBeVisible();
  });

  it.each([
    ["missing relation", undefined], ["null relation", null], ["object relation", execution],
    ["ambiguous execution", [execution, execution]], ["null execution", [null]],
    ["missing pointer", [{ ...execution, current_attempt_id: undefined }]],
    ["invalid pointer", [{ ...execution, current_attempt_id: "invalid" }]],
    ["nil pointer", [{ ...execution, current_attempt_id: "00000000-0000-0000-0000-000000000000" }]],
    ["null pointer with attempt", [{ ...execution, current_attempt_id: null }]],
    ["missing pointed attempt", [{ ...execution, current_attempt: null }]],
    ["omitted pointed attempt", [{ ...execution, current_attempt: undefined }]],
    ["array attempt", [{ ...execution, current_attempt: [attempt] }]],
    ["unknown phase", [{ ...execution, current_attempt: { ...attempt, phase: "succeeded" } }]],
    ["prototype phase", [{ ...execution, current_attempt: { ...attempt, phase: "toString" } }]],
    ["missing phase", [{ ...execution, current_attempt: { ...attempt, phase: undefined } }]],
    ...["task_id", "conversation_id", "organization_id", "project_id", "owner_user_id"].flatMap((field): [string, unknown][] => [
      [`wrong execution ${field}`, [{ ...execution, [field]: "other" }]],
      [`missing execution ${field}`, [{ ...execution, [field]: undefined }]],
      [`wrong attempt ${field}`, [{ ...execution, current_attempt: { ...attempt, [field]: "other" } }]],
      [`missing attempt ${field}`, [{ ...execution, current_attempt: { ...attempt, [field]: undefined } }]],
    ]),
  ])("rejects malformed linked evidence: %s", async (_name, taskExecution) => {
    query.abortSignal.mockResolvedValue({ data: [{ ...task, task_execution: taskExecution }], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(screen.getByText("Change status unavailable.")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByText("No current attempt recorded")).not.toBeInTheDocument();
  });

  it("labels the previous attempt stale when a refresh returns mismatched evidence", async () => {
    query.abortSignal.mockResolvedValue({ data: [taskWithAttempt], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    query.abortSignal.mockResolvedValue({ data: [{ ...taskWithAttempt,
      task_execution: [{ ...execution, current_attempt: { ...attempt, id: task.id, phase: "recovery_required" } }] }], error: null });
    await advance(5000);
    expect(screen.getByText(/Update unavailable. Showing last observed states/)).toBeVisible();
    expect(screen.getByText("Awaiting results")).toBeVisible();
    expect(screen.queryByText("Recovery required")).not.toBeInTheDocument();
  });

  it("rejects a wrong current attempt rather than showing its phase", async () => {
    query.abortSignal.mockResolvedValue({ data: [{ ...task, task_execution: [{ ...execution,
      current_attempt: { ...attempt, id: "10000000-0000-4000-8000-000000000003" } }] }], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(screen.getByText("Change status unavailable.")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("retains failed-refresh observations only with a stale label", async () => {
    render(<EngineeringTaskStatus {...props} />); await settle();
    query.abortSignal.mockRejectedValue(new Error("private server detail"));
    await advance(5000);
    expect(screen.getByText(/Update unavailable. Showing last observed states/)).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.queryByText("private server detail")).not.toBeInTheDocument();
  });

  it.each([
    { ...task, execution_state: "invented" },
    { ...task, verification_state: "passed" },
    { ...task, adoption_state: "released" },
    { ...task, engineering_decisions: null },
    { ...task, engineering_decisions: { sequence: -1 } },
  ])("rejects unknown or contradictory state instead of implying success: %j", async (row) => {
    query.abortSignal.mockResolvedValue({ data: [row], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(screen.getByText("Change status unavailable.")).toBeVisible();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("distinguishes an empty visible task set from completed work", async () => {
    query.abortSignal.mockResolvedValue({ data: [], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(screen.getByText("No accepted changes are visible yet.")).toBeVisible();
    expect(screen.queryByText(/All.*complete/)).not.toBeInTheDocument();
  });

  it.each([
    { code: "42501", status: 400 },
    { code: "PGRST301", status: 401 },
    { code: "unknown", status: 403 },
  ])("clears observations on access denial: %j", async ({ code, status }) => {
    query.abortSignal.mockResolvedValue({ data: [taskWithAttempt], error: null });
    render(<EngineeringTaskStatus {...props} />); await settle();
    query.abortSignal.mockResolvedValue({ data: null, error: { code }, status });
    await advance(5000);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByText("Change status unavailable.")).toBeVisible();
    expect(screen.queryByText("Awaiting results")).not.toBeInTheDocument();
  });

  it("never overlaps requests and bounds a transport that ignores abort", async () => {
    query.abortSignal.mockReturnValue(new Promise(() => {}));
    render(<EngineeringTaskStatus {...props} />); await settle();
    await advance(9999);
    expect(query.from).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(query.abortSignal.mock.calls[0][0].aborted).toBe(true);
    expect(screen.getByText("Change status unavailable.")).toBeVisible();
    await advance(5000);
    expect(query.from).toHaveBeenCalledTimes(2);
  });

  it("pauses hidden tabs, resumes when visible and cancels reads on unmount", async () => {
    query.abortSignal.mockResolvedValue({ data: [taskWithAttempt], error: null });
    const view = render(<EngineeringTaskStatus {...props} />); await settle();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(15000);
    expect(query.from).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    query.abortSignal.mockReturnValue(new Promise(() => {}));
    act(() => document.dispatchEvent(new Event("visibilitychange"))); await settle();
    expect(query.from).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(query.abortSignal.mock.calls[1][0].aborted).toBe(true);
    await advance(30000);
    expect(query.from).toHaveBeenCalledTimes(2);
  });

  it("does not display an old scope's late response after switching conversations", async () => {
    let finish: (value: unknown) => void;
    query.abortSignal.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<EngineeringTaskStatus {...props} />); await settle();
    query.abortSignal.mockResolvedValue({ data: [], error: null });
    view.rerender(<EngineeringTaskStatus {...props} conversationId="another" />); await settle();
    await act(async () => finish({ data: [taskWithAttempt], error: null }));
    expect(screen.queryByText("Change 7")).not.toBeInTheDocument();
    expect(screen.getByText("No accepted changes are visible yet.")).toBeVisible();
    expect(screen.queryByText("Awaiting results")).not.toBeInTheDocument();
  });

  it("ignores a late current-attempt result after the deadline and waits five seconds to read again", async () => {
    let finish: (value: unknown) => void;
    query.abortSignal.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<EngineeringTaskStatus {...props} />); await settle();
    await advance(10_000);
    await act(async () => finish({ data: [taskWithAttempt], error: null }));
    expect(screen.getByText("Change status unavailable.")).toBeVisible();
    expect(screen.queryByText("Awaiting results")).not.toBeInTheDocument();
    await advance(4999);
    expect(query.from).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(query.from).toHaveBeenCalledTimes(2);
    expect(screen.getByText("No current attempt recorded")).toBeVisible();
  });
});
