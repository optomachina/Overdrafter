import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EngineeringInbox from "./EngineeringInbox";

const mocks = vi.hoisted(() => ({ session: vi.fn(), from: vi.fn(), rpc: vi.fn(), abortSignal: vi.fn() }));
vi.mock("@/hooks/use-app-session", () => ({ useAppSession: mocks.session }));
vi.mock("@/features/engineering/EngineeringTaskStatus", () => ({ EngineeringTaskStatus: () => <div>Task observations</div> }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }));
const id = "10000000-0000-4000-8000-000000000001";
const owner = "10000000-0000-4000-8000-000000000002";
const snapshot = "10000000-0000-4000-8000-000000000003";
const nextSnapshot = "10000000-0000-4000-8000-000000000004";
const initial = { id, owner_user_id: owner, organization_id: id, project_id: id, head_snapshot_id: snapshot, revision: 2 };
let head = { ...initial };
let history = [{ id: snapshot, role: "user", body: "Earlier private request", sequence: 1, conversation_id: id, owner_user_id: owner, organization_id: id, project_id: id }];
let readsFail = false;
let readHead: (() => Promise<unknown>) | null = null;
function tree() { return <MemoryRouter initialEntries={[`/engineering?conversation=${id}`]}><EngineeringInbox /></MemoryRouter>; }
async function ready() {
  await screen.findByText("Conversation loaded. Showing up to 100 recent messages.");
  expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["engineering_conversations", "engineering_messages"]);
}
function send(body = "  Set depth to 8 mm.\n") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: body } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}
beforeEach(() => {
  vi.resetAllMocks();
  head = { ...initial };
  history = [{ id: snapshot, role: "user", body: "Earlier private request", sequence: 1, conversation_id: id, owner_user_id: owner, organization_id: id, project_id: id }];
  readsFail = false;
  readHead = null;
  mocks.session.mockReturnValue({ user: { id: owner }, authState: "authenticated", isAuthInitializing: false });
  mocks.from.mockImplementation((table: string) => {
    const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), single: vi.fn(), limit: vi.fn(), abortSignal: vi.fn() };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.order.mockReturnValue(query);
    query.single.mockReturnValue(query); query.limit.mockReturnValue(query);
    async function respond() {
      if (table === "engineering_conversations") {
        if (readHead) return readHead();
        return { data: readsFail ? null : { ...head }, error: readsFail ? {} : null };
      }
      return { data: history, error: null };
    }
    query.abortSignal.mockImplementation(() => {
      const pending = respond();
      return Object.assign(pending, { single: () => pending });
    });
    return query;
  });
  mocks.rpc.mockReturnValue({ abortSignal: mocks.abortSignal });
  mocks.abortSignal.mockImplementation(async () => ({ data: {
    conversationId: id, inputSnapshotId: snapshot, revision: 3, messageId: owner, requestId: nextSnapshot,
  }, error: null }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("authenticated engineering conversation intake", () => {
  it("waits for real session resolution and does not read private data when signed out", () => {
    mocks.session.mockReturnValue({ user: null, authState: "anonymous", isAuthInitializing: true });
    const view = render(tree());
    expect(screen.getByRole("status")).toHaveTextContent("Checking your session");
    mocks.session.mockReturnValue({ user: null, authState: "anonymous", isAuthInitializing: false });
    view.rerender(tree());
    expect(screen.getByRole("link", { name: "Sign in" })).toBeVisible();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("sends original text with server context, then reads the head instead of advancing from its receipt", async () => {
    render(tree()); await ready();
    head = { ...head, revision: 8, head_snapshot_id: nextSnapshot };
    send();
    await screen.findByText("Request recorded. CAD execution has not been confirmed.");
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_body: "  Set depth to 8 mm.\n", p_expected_revision: 2, p_input_snapshot_id: snapshot });
    expect(screen.getByRole("textbox")).toHaveValue("");
    send("Next request");
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_expected_revision: 8, p_input_snapshot_id: nextSnapshot });
    await screen.findByText(/Delivery is uncertain/); // The old receipt cannot validate the new Send.
  });

  it.each(["lost response", "malformed receipt"])("preserves exact retry identity after %s", async (failure) => {
    if (failure === "lost response") mocks.abortSignal.mockRejectedValueOnce(new Error("private detail"));
    else mocks.abortSignal.mockResolvedValueOnce({ data: { executed: true }, error: null });
    render(tree()); await ready(); send();
    await screen.findByText(/Delivery is uncertain/);
    expect(screen.getByRole("textbox")).toBeDisabled();
    head = { ...head, revision: 8 };
    fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
    await screen.findByText("Request recorded. CAD execution has not been confirmed.");
    expect(mocks.rpc.mock.calls[1]).toEqual(mocks.rpc.mock.calls[0]);
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
  });

  it("requires a context read and explicit adoption before a conflicting request can be sent anew", async () => {
    mocks.abortSignal.mockResolvedValueOnce({ data: null, error: { code: "PT409" } });
    render(tree()); await ready(); send();
    await screen.findByText(/The conversation changed/);
    expect(screen.getByRole("button", { name: "Retry original request" })).toBeDisabled();
    head = { ...head, revision: 7, head_snapshot_id: nextSnapshot };
    const reviewButton = screen.getByRole("button", { name: "Review latest context" });
    expect(reviewButton).toHaveClass("border", "border-border", "focus-visible:ring-2", "focus-visible:ring-ring");
    fireEvent.click(reviewButton);
    await screen.findByText("Revision 2 → 7");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const useButton = screen.getByRole("button", { name: "Use updated context" });
    expect(useButton).toHaveClass("border", "border-border", "focus-visible:ring-2", "focus-visible:ring-ring");
    fireEvent.click(useButton);
    expect(screen.getByRole("textbox")).toHaveValue("  Set depth to 8 mm.\n");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_expected_revision: 7, p_input_snapshot_id: nextSnapshot });
    expect(mocks.rpc.mock.calls[1][1].p_idempotency_key).not.toBe(mocks.rpc.mock.calls[0][1].p_idempotency_key);
    await screen.findByText(/Delivery is uncertain/);
  });

  it("blocks new sends when receipt succeeded but current context cannot be refreshed", async () => {
    render(tree()); await ready(); readsFail = true; send();
    await screen.findByText(/Request recorded.*Refresh to load/);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("unlocks an invalid request for editing without clearing its draft", async () => {
    mocks.abortSignal.mockResolvedValueOnce({ data: null, error: { code: "22023" } });
    render(tree()); await ready(); send("Depth must be clearer");
    await screen.findByText("This request could not be accepted. Check its text and context.");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Depth must be clearer");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByText(/Original pending request/)).not.toBeInTheDocument();
  });

  it("unlocks refresh after a recorded Send's read stalls and ignores its late head", async () => {
    render(tree()); await ready();
    vi.useFakeTimers();
    let finish: (value: unknown) => void;
    readHead = () => new Promise((resolve) => { finish = resolve; });
    send();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("status")).toHaveTextContent("Request recorded. CAD execution has not been confirmed. Refresh to load the latest conversation.");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.click(screen.getByText("Workbench tools"));
    const refresh = screen.getByRole("button", { name: "Refresh conversation" });
    expect(refresh).toBeEnabled();
    expect(refresh).toHaveClass("border", "border-border", "focus-visible:ring-2", "focus-visible:ring-ring");
    readHead = null; head = { ...head, revision: 7 };
    fireEvent.click(refresh);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole("status")).toHaveTextContent("Conversation loaded");
    await act(async () => { finish({ data: { ...initial, revision: 99 }, error: null }); });
    send("Next request");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_expected_revision: 7 });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps mismatched history out of the conversation and blocks Send", async () => {
    history = [{ ...history[0], owner_user_id: snapshot }];
    render(tree());
    await screen.findByText("Conversation unavailable. Check your access and try again.");
    expect(screen.queryByText("Earlier private request")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["engineering_conversations", "engineering_messages"]);
  });

  it("retains the request on access failure without exposing server diagnostics", async () => {
    mocks.abortSignal.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "private details" } });
    render(tree()); await ready(); send();
    await screen.findByText(/Access or context is unavailable/);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.queryByText("private details")).not.toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("prevents double sends while delivery is pending and discards late UI completion after sign out", async () => {
    let finish: (value: unknown) => void;
    mocks.abortSignal.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(tree()); await ready(); send();
    fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    mocks.session.mockReturnValue({ user: null, authState: "anonymous", isAuthInitializing: false });
    view.rerender(tree());
    expect(screen.queryByText("Earlier private request")).not.toBeInTheDocument();
    await act(async () => finish({ data: null, error: { code: "42501" } }));
    expect(screen.queryByText(/Access or context is unavailable/)).not.toBeInTheDocument();
  });

  it("does not carry private history or a pending request into another signed-in account", async () => {
    mocks.abortSignal.mockResolvedValueOnce({ data: {}, error: null });
    const view = render(tree()); await ready(); send();
    await screen.findByText(/Delivery is uncertain/);
    mocks.session.mockReturnValue({ user: { id: nextSnapshot }, authState: "authenticated", isAuthInitializing: false });
    view.rerender(tree());
    await screen.findByText("Conversation unavailable. Check your access and try again.");
    expect(screen.queryByText("Earlier private request")).not.toBeInTheDocument();
    expect(screen.queryByText(/Original pending request/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      "engineering_conversations", "engineering_messages", "engineering_conversations",
    ]);
  });
});
