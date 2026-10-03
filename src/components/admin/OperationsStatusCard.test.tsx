import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperationsStatusCard } from "./OperationsStatusCard";
import { OperationsStatusError } from "@/features/operations/operations-status-client";
import { parseOperationsSnapshot, OPERATIONS_CATEGORIES, OPERATIONS_SCHEMA, OPERATIONS_SUMMARIES, type OperationsSnapshot, type OperationsSeverity, type OperationsProvider } from "@/features/operations/contract";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/features/operations/operations-status-client", () => ({ fetchOperationsStatus: read,
  OperationsStatusError: class extends Error { constructor(public code: string) { super("Operations access unavailable."); } } }));
function fixture(): OperationsSnapshot {
  const now = new Date().toISOString();
  const items = OPERATIONS_CATEGORIES.map((category, index) => ({
    key: `${category}:${index === 2 ? "xometry" : "database"}`, category, subsystem: "database" as const, provider: index === 2 ? "xometry" as OperationsProvider : null,
    severity: (index === 0 ? "blocked" : index === 1 ? "healthy" : index === 2 ? "attention" : "unknown") as OperationsSeverity,
    context: { build: "abcdef1", model: "gpt-5.4", runtime: "live", adapterVersion: "1.2.3", sessionEvidenceAgeDays: 3, sessionEvidenceKind: "storage_modified_age" as const, taskType: "extract_part", taskStartedAt: now, taskCompletedAt: null, taskFailedAt: null },
    reasonCode: index === 0 ? "worker_not_ready" : index === 1 ? "runtime_known" : index === 2 ? "session_aging" : "source_unavailable",
    summary: OPERATIONS_SUMMARIES[index === 0 ? "worker_not_ready" : index === 1 ? "runtime_known" : index === 2 ? "session_aging" : "source_unavailable"],
    firstSeenAt: now, lastSeenAt: now, changedAt: now, lastCheckedAt: now,
    freshness: { state: "fresh" as const, ageMs: 0, maxAgeMs: 60000, expiresAt: new Date(Date.parse(now) + 60000).toISOString() },
    occurrenceCount: 2, action: category === "spend" ? { kind: "spend_control" as const, href: "/internal/admin#spend-controls" as const } : null,
  }));
  return parseOperationsSnapshot({ schema: OPERATIONS_SCHEMA, generatedAt: now, refreshAfterMs: 30000, items,
    counts: { healthy: 1, blocked: 1, attention: 1, unknown: 6 } });
}
function mount(userId = "admin-one") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><OperationsStatusCard key={userId} userId={userId} /></QueryClientProvider>);
  return { ...view, client, changeUser: (next: string) => view.rerender(<QueryClientProvider client={client}><OperationsStatusCard key={next} userId={next} /></QueryClientProvider>) };
}
beforeEach(() => { vi.resetAllMocks(); read.mockImplementation(async () => fixture()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const list = () => within(screen.getByRole("list", { name: "Operational observations" }));
describe("Operations attention view", () => {
  it("orders active items ahead of healthy detail and exposes safe context and controls", async () => {
    mount(); await screen.findByText("Showing 9 of 9 observations.");
    const rows = list().getAllByRole("listitem");
    expect(within(rows[0]).getByRole("heading")).toHaveTextContent("Worker");
    expect(within(rows[1]).getByRole("heading")).toHaveTextContent("Provider session");
    expect(within(rows[8]).getByRole("heading")).toHaveTextContent("Runtime");
    expect(screen.getByRole("heading", { name: "Operations", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText("gpt-5.4")).toHaveLength(9);
    expect(screen.getAllByText("Session storage modified age (days):")).toHaveLength(9);
    expect(screen.getAllByText(/does not establish current authentication/)).toHaveLength(9);
    expect(screen.getAllByText("Task Started At:")).toHaveLength(9);
    expect(screen.getByRole("link", { name: "Open spend controls" })).toHaveAttribute("href", "/internal/admin#spend-controls");
    expect(screen.queryByRole("button", { name: /dismiss|snooze|retry task/i })).not.toBeInTheDocument();
  });
  it("filters with labeled keyboard-native controls without fetching or changing global counts", async () => {
    mount(); await screen.findByText("Showing 9 of 9 observations.");
    const severity = screen.getByRole("combobox", { name: "Severity" }); severity.focus();
    fireEvent.change(severity, { target: { value: "blocked" } });
    expect(screen.getByText("Showing 1 of 9 observations.")).toBeInTheDocument();
    expect(severity).toHaveFocus();
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "runtime" } });
    expect(screen.getByText("No items match these filters.")).toBeInTheDocument();
    fireEvent.change(severity, { target: { value: "healthy" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Provider or subsystem" }), { target: { value: "database" } });
    expect(list().getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(severity, { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Provider or subsystem" }), { target: { value: "xometry" } });
    expect(list().getAllByRole("listitem")).toHaveLength(1);
    expect(list().getByRole("heading")).toHaveTextContent("Xometry");
    expect(screen.getByText("Blocked", { selector: "dt" }).nextElementSibling).toHaveTextContent("1");
    expect(read).toHaveBeenCalledOnce();
  });
  it("coalesces manual refresh and retains focus with no duplicate cards", async () => {
    mount(); await screen.findByText("Showing 9 of 9 observations.");
    let finish!: (value: OperationsSnapshot) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const button = screen.getByRole("button", { name: "Refresh operations" }); button.focus();
    fireEvent.click(button); fireEvent.click(button);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { finish(fixture()); });
    expect(await screen.findByRole("button", { name: "Refresh operations" })).toHaveFocus();
    expect(list().getAllByRole("listitem")).toHaveLength(9);
  });
  it("shows historical Unknown after refresh failure without displaying diagnostics", async () => {
    mount(); await screen.findByText("Showing 9 of 9 observations.");
    read.mockRejectedValueOnce(new Error("private server stack"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh operations" }));
    await screen.findByText(/Refresh unavailable/);
    expect(list().getAllByText("Unknown")).toHaveLength(9);
    expect(screen.queryByText("private server stack")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Prior observation:/)).toHaveLength(3);
  });
  it("clears denied data and its query cache without automatically retrying", async () => {
    const view = mount(); await screen.findByText("Showing 9 of 9 observations.");
    read.mockRejectedValueOnce(new OperationsStatusError("access_denied"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh operations" }));
    await screen.findByText("Operations access unavailable.");
    expect(list().queryAllByRole("listitem")).toHaveLength(0);
    expect(view.client.getQueryData(["admin-operations-status", "admin-one"])).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh operations" }));
    await screen.findByText("Showing 9 of 9 observations.");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("does not show previous-subject observations while the next subject loads", async () => {
    const view = mount(); await screen.findByText("Showing 9 of 9 observations.");
    read.mockImplementationOnce(() => new Promise(() => undefined));
    view.changeUser("admin-two");
    expect(list().queryAllByRole("listitem")).toHaveLength(0);
    expect(view.client.getQueryData(["admin-operations-status", "admin-one"])).toBeUndefined();
    view.unmount();
    expect(read.mock.calls[1][0].aborted).toBe(true);
  });
  it("expires observations between polls and polls only while visible", async () => {
    vi.useFakeTimers();
    let visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
    const data = fixture();
    read.mockResolvedValue({ ...data, items: data.items.map((item) => ({ ...item, freshness: { ...item.freshness, expiresAt: new Date(Date.now() + 1000).toISOString() } })) });
    mount(); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(list().getAllByRole("listitem")).toHaveLength(9);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(list().getAllByText("Unknown")).toHaveLength(9);
    await act(async () => { await vi.advanceTimersByTimeAsync(29000); });
    expect(read).toHaveBeenCalledTimes(2);
    visibility = "hidden"; act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(read).toHaveBeenCalledTimes(2);
    visibility = "visible"; act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
