import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EngineeringWorkbench from "./EngineeringWorkbench";

const model = vi.hoisted(() => ({
  importContext: vi.fn(), queue: vi.fn(), importResult: vi.fn(), restore: vi.fn(),
  serialize: vi.fn(), getJobText: vi.fn(),
}));
vi.mock("@/features/engineering/prepared-workflow", () => model);

const key = "overdrafter.engineering-workbench.v1";
const checks = ["input_identity", "native_integrity", "dimension", "assembly_references", "component_placements", "save_reopen", "source_preservation"];
const context = {
  assemblyPath: "synthetic-assembly.SLDASM", configuration: "Default",
  files: [
    { path: "synthetic-assembly.SLDASM", bytes: 59987 },
    { path: "parts/baseline-5mm.SLDPRT", bytes: 56144 },
    { path: "parts/candidate-8mm.SLDPRT", bytes: 56171 },
  ],
  dimension: { baseline: 5, minimum: 6, maximum: 10, occurrence: "baseline-5mm-1" },
  limitations: ["Synthetic fixed assembly; no mates or drawings."],
};
const empty = { context, contextText: "context-exact\n", contextSha256: "context-sha", records: [] };
const record = {
  job: { jobId: "job-1", attemptId: "attempt-1", depthMm: 8, requiredChecks: checks },
  jobText: "job-exact\n", requestSha256: "request-sha", result: null, resultText: null,
  intent: "accepted", execution: "waiting", checks: "unverified", adoption: "unadopted",
};
const queued = { ...empty, records: [record] };
const completed = {
  ...empty,
  records: [{ ...record, execution: "succeeded", checks: "passed", resultText: "result-exact\n", result: {
    checks: checks.map((id) => ({ id, verdict: "pass", evidenceSha256: `${id}-sha` })),
    measurements: { beforeDepthMm: 5, afterDepthMm: 8, beforeVolumeMm3: 1570.796, afterVolumeMm3: 2513.274 },
    candidateRoot: "C:\\Temp\\OVD-private-candidate", failureReason: null,
  } }],
};

function file(text: string) {
  const input = new File([text], "fixture.json", { type: "application/json" });
  Object.defineProperty(input, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return input;
}

async function importPrepared() {
  await screen.findByText("Import prepared context to begin.");
  fireEvent.change(screen.getByLabelText("Import prepared context"), { target: { files: [file("context-exact\n")] } });
  await screen.findByText("synthetic-assembly.SLDASM", { selector: "p" });
}

function seed(state = queued) {
  localStorage.setItem(key, JSON.stringify(state));
  model.restore.mockResolvedValue(state);
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  model.importContext.mockResolvedValue(empty);
  model.queue.mockResolvedValue(queued);
  model.importResult.mockResolvedValue(completed);
  model.restore.mockResolvedValue(queued);
  model.serialize.mockImplementation((state) => JSON.stringify(state));
  model.getJobText.mockImplementation((item) => item.jobText);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("EngineeringWorkbench", () => {
  it("imports exact context, queues a request, and revalidates the saved workbench on refresh", async () => {
    const view = render(<EngineeringWorkbench />);
    await importPrepared();
    expect(model.importContext).toHaveBeenCalledWith("context-exact\n");
    expect(localStorage.getItem(key)).toBe(JSON.stringify(empty));
    fireEvent.click(screen.getByRole("button", { name: "Queue dimension change" }));
    await screen.findByRole("button", { name: /01 · 5 → 8 mm/ });
    expect(localStorage.getItem(key)).toBe(JSON.stringify(queued));
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    expect(screen.getByText("Not adopted")).toBeInTheDocument();
    expect(screen.queryByText("Measured comparison")).not.toBeInTheDocument();
    view.unmount();
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    expect(model.restore).toHaveBeenCalledWith(JSON.stringify(queued));
    expect(screen.getByRole("button", { name: /01 · 5 → 8 mm/ })).toBeInTheDocument();
  });

  it("keeps the previous view when the context or queue cannot be saved", async () => {
    render(<EngineeringWorkbench />);
    await screen.findByText("Import prepared context to begin.");
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    fireEvent.change(screen.getByLabelText("Import prepared context"), { target: { files: [file("context-exact\n")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this change");
    expect(screen.queryByLabelText("Requested depth (mm)")).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBeNull();
    save.mockRestore();
    fireEvent.change(screen.getByLabelText("Import prepared context"), { target: { files: [file("context-exact\n")] } });
    await screen.findByLabelText("Requested depth (mm)");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    fireEvent.click(screen.getByRole("button", { name: "Queue dimension change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your previous workbench was kept");
    expect(screen.queryByRole("button", { name: /01 · 5 → 8 mm/ })).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(empty));
  });

  it("does not show an imported result until its save succeeds", async () => {
    seed();
    render(<EngineeringWorkbench />);
    await screen.findByLabelText("Import native result");
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    fireEvent.change(screen.getByLabelText("Import native result"), { target: { files: [file("result-exact\n")] } });
    await screen.findByRole("alert");
    expect(screen.queryByText("Measured comparison")).not.toBeInTheDocument();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(queued));
    save.mockRestore();
    fireEvent.change(screen.getByLabelText("Import native result"), { target: { files: [file("result-exact\n")] } });
    await screen.findByText("Measured comparison");
    expect(screen.getByText("Native checks passed (imported evidence)")).toBeInTheDocument();
    expect(screen.getAllByText("Pass")).toHaveLength(7);
    expect(screen.getByText("2513.274")).toBeInTheDocument();
    expect(screen.getByText("C:\\Temp\\OVD-private-candidate")).toBeInTheDocument();
    expect(screen.getByText("Not adopted")).toBeInTheDocument();
  });

  it("locks concurrent mutations while a queue operation is unresolved", async () => {
    let resolveQueue: (state: typeof queued) => void = () => undefined;
    model.queue.mockImplementation(() => new Promise((resolve) => { resolveQueue = resolve; }));
    render(<EngineeringWorkbench />);
    await importPrepared();
    const button = screen.getByRole("button", { name: "Queue dimension change" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset workbench" })).toBeDisabled();
    expect(model.queue).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(JSON.stringify(empty));
    await act(async () => { resolveQueue(queued); });
    expect(button).toBeEnabled();
    expect(screen.getByRole("button", { name: /01 · 5 → 8 mm/ })).toBeInTheDocument();
  });

  it("retains invalid stored data until reset is explicitly confirmed", async () => {
    localStorage.setItem(key, "damaged-data");
    model.restore.mockRejectedValue(new Error("Invalid saved receipt"));
    render(<EngineeringWorkbench />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No saved data was changed");
    expect(screen.getByLabelText("Import prepared context")).toBeDisabled();
    expect(localStorage.getItem(key)).toBe("damaged-data");
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep workbench" }));
    expect(localStorage.getItem(key)).toBe("damaged-data");
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset saved workbench" }));
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
    expect(screen.getByLabelText("Import prepared context")).toBeEnabled();
  });

  it("rejects reset when another tab saves after confirmation opens and requires fresh review", async () => {
    seed();
    const view = render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    localStorage.setItem(key, JSON.stringify(completed));
    fireEvent.click(screen.getByRole("button", { name: "Reset saved workbench" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed after this confirmation opened");
    expect(localStorage.getItem(key)).toBe(JSON.stringify(completed));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue dimension change" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh to review");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(completed));

    view.unmount();
    model.restore.mockResolvedValue(completed);
    render(<EngineeringWorkbench />);
    await screen.findByText("Measured comparison");
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset saved workbench" }));
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
  });

  it("preserves replacement data when corrupted storage changes during reset confirmation", async () => {
    localStorage.setItem(key, "damaged-data");
    model.restore.mockRejectedValue(new Error("Invalid saved receipt"));
    render(<EngineeringWorkbench />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    localStorage.setItem(key, JSON.stringify(queued));
    fireEvent.click(screen.getByRole("button", { name: "Reset saved workbench" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed after this confirmation opened");
    expect(localStorage.getItem(key)).toBe(JSON.stringify(queued));
    expect(screen.getByLabelText("Import prepared context")).toBeDisabled();
  });

  it("does not overwrite another tab's newer workbench", async () => {
    render(<EngineeringWorkbench />);
    await importPrepared();
    localStorage.setItem(key, "newer-external-state");
    fireEvent.click(screen.getByRole("button", { name: "Queue dimension change" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another tab");
    expect(localStorage.getItem(key)).toBe("newer-external-state");
    expect(screen.getByRole("button", { name: "Queue dimension change" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /01 · 5 → 8 mm/ })).not.toBeInTheDocument();
  });

  it("shows failed results and missing checks without implying a verified candidate", async () => {
    const failed = { ...queued, records: [{ ...record, execution: "failed", checks: "failed", resultText: "failure", result: {
      failureReason: "Source identity changed", checks: [], measurements: null, candidateRoot: null,
    } }] };
    localStorage.setItem(key, JSON.stringify(failed));
    model.restore.mockResolvedValue(failed);
    render(<EngineeringWorkbench />);
    await screen.findByText("Checks failed or incomplete");
    expect(screen.getByText(/Source identity changed/)).toBeInTheDocument();
    expect(screen.getAllByText("Missing")).toHaveLength(7);
    expect(screen.getByText("Not adopted")).toBeInTheDocument();
    expect(screen.queryByText("Measured comparison")).not.toBeInTheDocument();
  });

  it("prevents a sixth decision and requires reset before changing context", async () => {
    const full = { ...empty, records: Array.from({ length: 5 }, (_, i) => ({ ...record, job: { ...record.job, jobId: `job-${i}` } })) };
    localStorage.setItem(key, JSON.stringify(full));
    model.restore.mockResolvedValue(full);
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    expect(screen.getByRole("button", { name: "Queue dimension change" })).toBeDisabled();
    expect(screen.queryByLabelText("Import prepared context")).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Queued decisions" })).getAllByRole("button")).toHaveLength(5);
  });

  it("keeps saved context and decisions when an explicitly requested reset fails", async () => {
    seed();
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset saved workbench" }));
    await waitFor(() => expect(screen.getByText(/Could not reset the workbench/)).toBeInTheDocument());
    expect(localStorage.getItem(key)).toBe(JSON.stringify(queued));
    fireEvent.click(screen.getByRole("button", { name: "Keep workbench" }));
    expect(screen.getByRole("button", { name: /01 · 5 → 8 mm/ })).toBeInTheDocument();
  });

  it("downloads the exact stored request without changing execution state", async () => {
    seed();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:local-test");
    class TestURL extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<EngineeringWorkbench />);
    const button = await screen.findByRole("button", { name: "Download request JSON" });
    fireEvent.click(button);
    expect(model.getJobText).toHaveBeenCalledWith(record);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const downloaded = createObjectURL.mock.calls[0][0] as Blob;
    expect(await new Promise((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(downloaded);
    })).toBe("job-exact\n");
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Downloading does not start CAD");
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(queued));
  });
});
