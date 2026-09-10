import "@testing-library/jest-dom/vitest";
import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EngineeringWorkbench from "./EngineeringWorkbench";

const model = vi.hoisted(() => ({
  importContext: vi.fn(), queue: vi.fn(), importResult: vi.fn(), restore: vi.fn(),
  serialize: vi.fn(), getJobText: vi.fn(),
}));
vi.mock("@/features/engineering/prepared-workflow", () => model);
vi.mock("@/components/CadModelThumbnail", () => ({
  CadModelThumbnail: ({ source }: { source: { cacheKey: string } }) => <div data-testid="cad-preview">{source.cacheKey}</div>,
}));

const key = "overdrafter.engineering-workbench.v1";
const checks = ["input_identity", "native_integrity", "dimension", "assembly_references", "component_placements", "save_reopen", "source_preservation"];
const context = {
  assemblyPath: "synthetic-assembly.SLDASM", configuration: "Default",
  files: [
    { path: "synthetic-assembly.SLDASM", bytes: 59987, sha256: "a".repeat(64) },
    { path: "parts/baseline-5mm.SLDPRT", bytes: 56144, sha256: "b".repeat(64) },
    { path: "parts/candidate-8mm.SLDPRT", bytes: 56171, sha256: "c".repeat(64) },
  ],
  dimension: { id: "baseline-depth", unit: "mm", baseline: 5, minimum: 6, maximum: 10, occurrence: "baseline-5mm-1" },
  limitations: ["Synthetic fixed assembly; no mates or drawings."],
};
const empty = { context, contextText: "context-exact\n", contextSha256: "d".repeat(64), records: [] };
const record = {
  job: { jobId: "job-1", attemptId: "attempt-1", depthMm: 8, requiredChecks: checks },
  jobText: "job-exact\n", requestSha256: "e".repeat(64), result: null, resultText: null,
  intent: "accepted", execution: "waiting", checks: "unverified", adoption: "unadopted",
};
const queued = { ...empty, records: [record] };
const completed = {
  ...empty,
  records: [{ ...record, execution: "succeeded", checks: "passed", resultText: "result-exact\n", result: {
    outcome: "succeeded", outputFiles: context.files,
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
  openTools();
  fireEvent.change(screen.getByLabelText("Import prepared context"), { target: { files: [file("context-exact\n")] } });
  await screen.findByText("synthetic-assembly.SLDASM", { selector: "p" });
}

function openTools() {
  const summary = screen.getByText("Workbench tools");
  if (!summary.closest("details")?.open) fireEvent.click(summary);
}

function openConversation() {
  const button = screen.getByRole("button", { name: "Conversation" });
  if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
}

function openChecks() {
  openConversation();
  const summary = screen.getByText("Checks and measured results");
  if (!summary.closest("details")?.open) fireEvent.click(summary);
}

function sendMessage(text = "Set the depth to 8 mm") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

function confirmProposal() {
  fireEvent.click(screen.getByRole("button", { name: "Evaluate this change" }));
}

function proposeAndConfirm(text = "Set the depth to 8 mm") {
  sendMessage(text);
  confirmProposal();
}

function seed(state = queued) {
  localStorage.setItem(key, JSON.stringify(state));
  model.restore.mockResolvedValue(state);
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  // Node 20 rejects jsdom-realm ArrayBuffers; bridge exact bytes into Node without mocking SHA-256.
  vi.stubGlobal("crypto", {
    subtle: {
      digest: (algorithm: string, data: ArrayBuffer) => webcrypto.subtle.digest(algorithm, Buffer.from(data)),
    },
  });
  model.importContext.mockResolvedValue(empty);
  model.queue.mockResolvedValue(queued);
  model.importResult.mockResolvedValue(completed);
  model.restore.mockResolvedValue(queued);
  model.serialize.mockImplementation((state) => JSON.stringify(state));
  model.getJobText.mockImplementation((item) => item.jobText);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("EngineeringWorkbench", () => {
  it("asks for missing context and never queues a message before explicit confirmation", async () => {
    render(<EngineeringWorkbench />);
    await screen.findByText("Import prepared context to begin.");
    sendMessage();
    expect(screen.getByText(/Import the prepared assembly context first/)).toBeInTheDocument();
    expect(model.queue).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Evaluate this change" })).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("asks for missing depth and units before preparing a confirmable decision", async () => {
    render(<EngineeringWorkbench />);
    await importPrepared();
    sendMessage("Make it thicker");
    expect(screen.getByText(/What target depth should the baseline part have/)).toBeInTheDocument();
    sendMessage("8");
    expect(screen.getByText(/Which units do you mean for 8/)).toBeInTheDocument();
    expect(model.queue).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Evaluate this change" })).not.toBeInTheDocument();
    sendMessage("mm");
    expect(screen.getByRole("button", { name: "Evaluate this change" })).toBeEnabled();
    expect(model.queue).not.toHaveBeenCalled();
    confirmProposal();
    await screen.findByRole("button", { name: /01 · 5 → 8 mm/ });
    openChecks();
    expect(model.queue).toHaveBeenCalledExactlyOnceWith(empty, 8);
  });

  it("cancels or replaces a proposal without accepting the previous depth", async () => {
    render(<EngineeringWorkbench />);
    await importPrepared();
    sendMessage();
    fireEvent.click(screen.getByRole("button", { name: "Cancel proposal" }));
    expect(screen.queryByRole("button", { name: "Evaluate this change" })).not.toBeInTheDocument();
    expect(model.queue).not.toHaveBeenCalled();
    sendMessage();
    sendMessage("Set the depth to 9 mm");
    expect(screen.getAllByRole("button", { name: "Evaluate this change" })).toHaveLength(1);
    expect(model.queue).not.toHaveBeenCalled();
    const revised = { ...empty, records: [{ ...record, job: { ...record.job, depthMm: 9 } }] };
    model.queue.mockResolvedValue(revised);
    confirmProposal();
    await screen.findByRole("button", { name: /01 · 5 → 9 mm/ });
    expect(model.queue).toHaveBeenCalledExactlyOnceWith(empty, 9);
  });

  it("imports exact context, queues a request, and revalidates the saved workbench on refresh", async () => {
    const view = render(<EngineeringWorkbench />);
    await importPrepared();
    expect(model.importContext).toHaveBeenCalledWith("context-exact\n");
    expect(localStorage.getItem(key)).toBe(JSON.stringify(empty));
    sendMessage();
    expect(model.queue).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(empty));
    confirmProposal();
    await screen.findByRole("button", { name: /01 · 5 → 8 mm/ });
    expect(localStorage.getItem(key)).toBe(JSON.stringify(queued));
    openChecks();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    expect(screen.getByText("Not adopted")).toBeInTheDocument();
    expect(screen.queryByText("Measured comparison")).not.toBeInTheDocument();
    view.unmount();
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    openConversation();
    openTools();
    expect(model.restore).toHaveBeenCalledWith(JSON.stringify(queued));
    expect(screen.getByRole("button", { name: /01 · 5 → 8 mm/ })).toBeInTheDocument();
  });

  it("keeps the previous view when the context or queue cannot be saved", async () => {
    render(<EngineeringWorkbench />);
    await screen.findByText("Import prepared context to begin.");
    openTools();
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    fireEvent.change(screen.getByLabelText("Import prepared context"), { target: { files: [file("context-exact\n")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save this change");
    expect(screen.queryByRole("button", { name: "Evaluate this change" })).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBeNull();
    save.mockRestore();
    fireEvent.change(screen.getByLabelText("Import prepared context"), { target: { files: [file("context-exact\n")] } });
    await screen.findByText("synthetic-assembly.SLDASM", { selector: "p" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    proposeAndConfirm();
    expect(await screen.findByRole("alert")).toHaveTextContent("Your previous workbench was kept");
    expect(screen.queryByRole("button", { name: /01 · 5 → 8 mm/ })).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(empty));
    expect(screen.getByRole("button", { name: "Evaluate this change" })).toBeEnabled();
  });

  it("does not show an imported result until its save succeeds", async () => {
    seed();
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    openConversation();
    openTools();
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    fireEvent.change(screen.getByLabelText("Import native result"), { target: { files: [file("result-exact\n")] } });
    await screen.findByRole("alert");
    openChecks();
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
    sendMessage();
    const button = screen.getByRole("button", { name: "Evaluate this change" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset workbench" })).toBeDisabled();
    expect(model.queue).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBe(JSON.stringify(empty));
    await act(async () => { resolveQueue(queued); });
    expect(screen.queryByRole("button", { name: "Evaluate this change" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /01 · 5 → 8 mm/ })).toBeInTheDocument();
  });

  it("retains invalid stored data until reset is explicitly confirmed", async () => {
    localStorage.setItem(key, "damaged-data");
    model.restore.mockRejectedValue(new Error("Invalid saved receipt"));
    render(<EngineeringWorkbench />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No saved data was changed");
    openTools();
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
    openConversation();
    openTools();
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    localStorage.setItem(key, JSON.stringify(completed));
    fireEvent.click(screen.getByRole("button", { name: "Reset saved workbench" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed after this confirmation opened");
    expect(localStorage.getItem(key)).toBe(JSON.stringify(completed));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh to review");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(completed));

    view.unmount();
    model.restore.mockResolvedValue(completed);
    render(<EngineeringWorkbench />);
    await screen.findByText("Measured comparison");
    openTools();
    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset saved workbench" }));
    await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
  });

  it("preserves replacement data when corrupted storage changes during reset confirmation", async () => {
    localStorage.setItem(key, "damaged-data");
    model.restore.mockRejectedValue(new Error("Invalid saved receipt"));
    render(<EngineeringWorkbench />);
    await screen.findByRole("alert");
    openTools();
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
    sendMessage();
    localStorage.setItem(key, "newer-external-state");
    confirmProposal();
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in another tab");
    expect(localStorage.getItem(key)).toBe("newer-external-state");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
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
    openTools();
    openChecks();
    expect(screen.getByText(/Source identity changed/)).toBeInTheDocument();
    expect(screen.getAllByText("Missing")).toHaveLength(7);
    expect(screen.getByText("Not adopted")).toBeInTheDocument();
    expect(screen.queryByText("Measured comparison")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "After · 8 mm" }));
    expect(screen.getByText("Candidate evaluation failed")).toBeInTheDocument();
    expect(screen.getByText(/Review the failure details in the conversation/)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for candidate geometry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cad-preview")).not.toBeInTheDocument();
  });

  it("prevents a sixth decision and requires reset before changing context", async () => {
    const full = { ...empty, records: Array.from({ length: 5 }, (_, i) => ({ ...record, job: { ...record.job, jobId: `job-${i}` } })) };
    localStorage.setItem(key, JSON.stringify(full));
    model.restore.mockResolvedValue(full);
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    openConversation();
    openTools();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Evaluate this change" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Import prepared context")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^0[1-5] · 5 → 8 mm/ })).toHaveLength(5);
  });

  it("keeps saved context and decisions when an explicitly requested reset fails", async () => {
    seed();
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    openConversation();
    openTools();
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
    await screen.findByText("Saved workbench restored and revalidated.");
    openConversation();
    openTools();
    const button = screen.getByRole("button", { name: "Download request JSON" });
    fireEvent.click(button);
    expect(model.getJobText).toHaveBeenCalledWith(record);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const downloaded = createObjectURL.mock.calls[0][0] as Blob;
    expect(await new Promise((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(downloaded);
    })).toBe("job-exact\n");
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Downloading does not start CAD");
    openChecks();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(queued));
  });

  it("does not display a completed request's CAD preview for another pending request", async () => {
    const pending = { ...record, requestSha256: "f".repeat(64), job: { ...record.job, jobId: "job-2", depthMm: 9 } };
    const mixed = { ...completed, records: [completed.records[0], pending] };
    localStorage.setItem(key, JSON.stringify(mixed));
    model.restore.mockResolvedValue(mixed);
    // This unit fixture tests identity selection; only the renderer is mocked.
    const step = Buffer.from("ISO-10303-21;\nUNIT-TEST-ONLY\nEND-ISO-10303-21;\n");
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const preview = {
      schema: "overdrafter.prepared-step-preview.v1", contextSha256: empty.contextSha256,
      role: "candidate", requestSha256: record.requestSha256, resultSha256: hash("result-exact\n"),
      configuration: "Default", nativeFiles: context.files,
      step: { fileName: "assembly.step", bytes: step.length, sha256: hash(step), base64: step.toString("base64") },
      export: { nativeVersion: "30.5.0", reportSha256: "a".repeat(64), sourceCommit: null },
      limitations: ["Unit fixture for selection; native geometry is not asserted."],
    };
    localStorage.setItem("overdrafter.engineering-previews.v1", JSON.stringify({ schema: "overdrafter.prepared-previews.v1", entries: [JSON.stringify(preview)] }));
    render(<EngineeringWorkbench />);
    await screen.findByText("Saved workbench restored and revalidated.");
    openConversation();
    fireEvent.click(screen.getByRole("button", { name: "After · 8 mm" }));
    expect(await screen.findByTestId("cad-preview")).toHaveTextContent(`prepared-step:${hash(step)}`);
    openTools();
    fireEvent.click(screen.getByRole("button", { name: /02 · 5 → 9 mm/ }));
    fireEvent.click(screen.getByRole("button", { name: "After · 9 mm" }));
    expect(screen.getByText("Waiting for candidate geometry")).toBeInTheDocument();
    expect(screen.queryByTestId("cad-preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /01 · 5 → 8 mm/ }));
    fireEvent.click(screen.getByRole("button", { name: "After · 8 mm" }));
    expect(screen.getByTestId("cad-preview")).toHaveTextContent(`prepared-step:${hash(step)}`);
  });

  it("preserves the entire preview store after failed restore until full reset, keeping native results usable", async () => {
    const previewKey = "overdrafter.engineering-previews.v1";
    const step = Buffer.from("ISO-10303-21;\nUNIT-TEST-ONLY\n");
    const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const baseline = {
      schema: "overdrafter.prepared-step-preview.v1", contextSha256: empty.contextSha256,
      role: "baseline", requestSha256: null, resultSha256: null,
      configuration: "Default", nativeFiles: context.files,
      step: { fileName: "assembly.step", bytes: step.length, sha256: hash(step), base64: step.toString("base64") },
      export: { nativeVersion: "30.5.0", reportSha256: "a".repeat(64), sourceCommit: null },
      limitations: ["Unit fixture for persistence only; no native geometry is asserted."],
    };
    const corruptedCandidate = {
      ...baseline, role: "candidate", requestSha256: record.requestSha256, resultSha256: hash("result-exact\n"),
      step: { ...baseline.step, bytes: step.length + 1 },
    };
    const saved = JSON.stringify({ schema: "overdrafter.prepared-previews.v1", entries: [JSON.stringify(baseline), JSON.stringify(corruptedCandidate)] });
    localStorage.setItem(key, JSON.stringify(completed));
    localStorage.setItem(previewKey, saved);
    model.restore.mockResolvedValue(completed);
    render(<EngineeringWorkbench />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Saved CAD previews could not be restored/);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Conversation" })).toHaveAttribute("aria-expanded", "true");
    openTools();
    const input = screen.getByLabelText("Import CAD preview");
    expect(input).toBeDisabled();
    expect(screen.getByLabelText("Import native result")).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    // Exercise the handler guard too: a programmatic event must not bypass the disabled control.
    fireEvent.change(input, { target: { files: [file(JSON.stringify(baseline))] } });
    await waitFor(() => expect(localStorage.getItem(previewKey)).toBe(saved));
    fireEvent.change(screen.getByLabelText("Import native result"), { target: { files: [file("result-exact\n")] } });
    await screen.findByText(/Native result imported and matched to its exact request/);
    expect(model.importResult).toHaveBeenCalledWith(completed, "result-exact\n");
    expect(localStorage.getItem(previewKey)).toBe(saved);
    expect(screen.getByLabelText("Import CAD preview")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reset workbench" }));
    expect(screen.getByText(/imported results, and CAD previews from this browser/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset saved workbench" }));
    await screen.findByText("Local workbench reset. Import prepared context to begin.");
    expect(localStorage.getItem(previewKey)).toBeNull();
    fireEvent.change(screen.getByLabelText("Import prepared context"), { target: { files: [file("context-exact\n")] } });
    await screen.findByText(/Prepared context imported/);
    expect(screen.getByLabelText("Import CAD preview")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Import CAD preview"), { target: { files: [file(JSON.stringify(baseline))] } });
    expect(await screen.findByTestId("cad-preview")).toHaveTextContent(`prepared-step:${hash(step)}`);
    expect(localStorage.getItem(previewKey)).not.toBe(saved);
  });
});
