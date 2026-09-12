import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineeringTaskStatus } from "./EngineeringTaskStatus";

const query = vi.hoisted(() => ({ from: vi.fn(), select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: query.from } }));
const props = { conversationId: "conversation", organizationId: "organization", projectId: "project", ownerId: "owner" };
const task = { id: "10000000-0000-4000-8000-000000000001", execution_state: "running", verification_state: "unverified", adoption_state: "unadopted", engineering_decisions: { sequence: 7 } };
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  for (const name of ["from", "select", "eq", "order", "limit"] as const) query[name].mockReturnValue(query);
  query.abortSignal.mockResolvedValue({ data: [task], error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("accepted engineering change observations", () => {
  it("reads only the current owner/scope and displays execution, verification and adoption independently", async () => {
    render(<EngineeringTaskStatus {...props} />); await settle();
    expect(query.from).toHaveBeenCalledExactlyOnceWith("engineering_tasks");
    for (const pair of [["conversation_id", props.conversationId], ["organization_id", props.organizationId], ["project_id", props.projectId], ["owner_user_id", props.ownerId]]) expect(query.eq).toHaveBeenCalledWith(...pair);
    expect(query.limit).toHaveBeenCalledWith(25);
    const change = screen.getByRole("article", { name: "Change 7" });
    expect(within(change).getByText("Running")).toBeVisible();
    expect(within(change).getByText("Unverified")).toBeVisible();
    expect(within(change).getByText("Not adopted")).toBeVisible();
    query.abortSignal.mockResolvedValue({ data: [{ ...task, execution_state: "succeeded", verification_state: "checking" }], error: null });
    await advance(5000);
    expect(within(change).getByText("Succeeded")).toBeVisible();
    expect(within(change).getByText("Checking")).toBeVisible();
    expect(screen.queryByText("Passed")).not.toBeInTheDocument();
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
    render(<EngineeringTaskStatus {...props} />); await settle();
    query.abortSignal.mockResolvedValue({ data: null, error: { code }, status });
    await advance(5000);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByText("Change status unavailable.")).toBeVisible();
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
    await act(async () => finish({ data: [task], error: null }));
    expect(screen.queryByText("Change 7")).not.toBeInTheDocument();
    expect(screen.getByText("No accepted changes are visible yet.")).toBeVisible();
  });
});
