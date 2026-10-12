import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportControlJobStatusPanel } from "./ExportControlJobStatusPanel";
import type { JobExportControlStatus } from "@/features/quotes/api/export-control-api";

const apiMock = vi.hoisted(() => ({
  getJobExportControlStatus: vi.fn(),
  declareExistingJobExportStatus: vi.fn(),
  requestExportControlRescan: vi.fn(),
}));

vi.mock("@/features/quotes/api/export-control-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/quotes/api/export-control-api")>()),
  ...apiMock,
}));

const BACKFILLED: JobExportControlStatus = {
  jobId: "job-1",
  latestAnswer: "missing",
  reviewState: "clear",
  partsMissingScan: 2,
  rescansPending: 0,
};

function renderPanel(canDeclare = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExportControlJobStatusPanel jobId="job-1" canDeclare={canDeclare} />
    </QueryClientProvider>,
  );
}

describe("ExportControlJobStatusPanel (existing jobs)", () => {
  beforeEach(() => {
    for (const fn of Object.values(apiMock)) fn.mockReset();
  });

  it("asks a member to declare with no default answer, then saves the chosen answer", async () => {
    apiMock.getJobExportControlStatus.mockResolvedValue(BACKFILLED);
    apiMock.declareExistingJobExportStatus.mockResolvedValue({ answer: "not_controlled", declarationClean: true });
    renderPanel();

    const save = await screen.findByRole("button", { name: "Save answer" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Not export-controlled/ }));
    fireEvent.click(save);
    await waitFor(() => expect(apiMock.declareExistingJobExportStatus).toHaveBeenCalledWith("job-1", "not_controlled"));
    await waitFor(() => expect(apiMock.getJobExportControlStatus).toHaveBeenCalledTimes(2));
  });

  it.each([
    [/^Export-controlled/, "controlled"],
    [/I'm not sure/, "unsure"],
  ])("warns that %s keeps the job on hold and records it", async (label, answer) => {
    apiMock.getJobExportControlStatus.mockResolvedValue(BACKFILLED);
    apiMock.declareExistingJobExportStatus.mockResolvedValue({ answer, declarationClean: false });
    renderPanel();

    fireEvent.click(await screen.findByRole("radio", { name: label }));
    expect(screen.getByRole("alert").textContent).toMatch(/stays on hold/);
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(apiMock.declareExistingJobExportStatus).toHaveBeenCalledWith("job-1", answer));
  });

  it("requests a rescan for parts without a scan", async () => {
    apiMock.getJobExportControlStatus.mockResolvedValue({ ...BACKFILLED, latestAnswer: "not_controlled" });
    apiMock.requestExportControlRescan.mockResolvedValue({ tasksQueued: 2 });
    renderPanel();

    expect(await screen.findByText(/2 parts have no export-marking scan/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save answer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rescan files" }));
    await waitFor(() => expect(apiMock.requestExportControlRescan).toHaveBeenCalledWith("job-1"));
  });

  it("disables the rescan while one is running", async () => {
    apiMock.getJobExportControlStatus.mockResolvedValue({ ...BACKFILLED, rescansPending: 2 });
    renderPanel();
    const button = await screen.findByRole("button", { name: "Rescan running" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a platform admin rescan but not declare", async () => {
    apiMock.getJobExportControlStatus.mockResolvedValue(BACKFILLED);
    renderPanel(false);
    expect(await screen.findByRole("button", { name: "Rescan files" })).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("renders nothing once dispatch is no longer held", async () => {
    apiMock.getJobExportControlStatus.mockResolvedValue({
      ...BACKFILLED,
      latestAnswer: "not_controlled",
      partsMissingScan: 0,
    });
    const { container } = renderPanel();
    await waitFor(() => expect(apiMock.getJobExportControlStatus).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("shows the job as on hold when the status can't be loaded", async () => {
    apiMock.getJobExportControlStatus.mockRejectedValue(new Error("down"));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toMatch(/stays on hold/);
  });
});
