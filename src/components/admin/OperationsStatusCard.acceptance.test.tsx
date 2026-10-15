import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { OperationsStatusCard } from "./OperationsStatusCard";
import { OPERATIONS_CATEGORIES, OPERATIONS_SCHEMA, OPERATIONS_SUMMARIES, type OperationsSnapshot } from "@/features/operations/contract";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/features/operations/operations-status-client", () => ({ fetchOperationsStatus: read,
  OperationsStatusError: class extends Error { constructor(public code: string) { super("Operations unavailable."); } } }));
function snapshot(): OperationsSnapshot {
  return { schema: OPERATIONS_SCHEMA, generatedAt: new Date().toISOString(), refreshAfterMs: 30000,
    counts: { healthy: 0, blocked: 0, attention: 0, unknown: 9 },
    items: OPERATIONS_CATEGORIES.map(category => ({
      key: `${category}:database`, category, severity: "unknown", subsystem: "database", provider: null,
      context: { build: null, model: null, runtime: null, adapterVersion: null, sessionEvidenceAgeDays: null, sessionEvidenceKind: null, taskType: null, taskStartedAt: null, taskCompletedAt: null, taskFailedAt: null },
      reasonCode: "source_unavailable", summary: OPERATIONS_SUMMARIES.source_unavailable,
      firstSeenAt: null, lastSeenAt: null, changedAt: null, lastCheckedAt: null,
      freshness: { state: "unknown", ageMs: null, maxAgeMs: null, expiresAt: null }, occurrenceCount: null, action: null,
    })),
  };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("noncooperative old-subject resolution cannot repopulate the cache or current subject DOM", async () => {
  let complete!: (value: OperationsSnapshot) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  read.mockImplementationOnce(() => new Promise(() => undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (subject: string) => <QueryClientProvider client={client}><OperationsStatusCard key={subject} userId={subject} /></QueryClientProvider>;
  const view = render(tree("old-subject"));
  expect(read).toHaveBeenCalledOnce();
  const oldSignal = read.mock.calls[0][0] as AbortSignal;
  view.rerender(tree("new-subject"));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { complete(snapshot()); await Promise.resolve(); });
  expect(client.getQueryData(["admin-operations-status", "old-subject"])).toBeUndefined();
  expect(client.getQueryData(["admin-operations-status", "new-subject"])).toBeUndefined();
  expect(within(screen.getByRole("list", { name: "Operational observations" })).queryAllByRole("listitem")).toHaveLength(0);
});

it("revoking the mount boundary removes cached data and ignores a late same-subject response", async () => {
  let complete!: (value: OperationsSnapshot) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><OperationsStatusCard userId="revoked-subject" /></QueryClientProvider>);
  const signal = read.mock.calls[0][0] as AbortSignal;
  view.rerender(<QueryClientProvider client={client}><p>Access revoked</p></QueryClientProvider>);
  expect(signal.aborted).toBe(true);
  await act(async () => { complete(snapshot()); await Promise.resolve(); });
  expect(client.getQueryData(["admin-operations-status", "revoked-subject"])).toBeUndefined();
  expect(screen.queryByRole("heading", { name: "Operations" })).not.toBeInTheDocument();
});
