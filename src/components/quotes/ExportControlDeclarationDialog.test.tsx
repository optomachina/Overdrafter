import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExportControlDeclarationDialogHost } from "./ExportControlDeclarationDialog";
import { requestExportControlAnswer } from "@/features/quotes/export-control";

function openPrompt() {
  let pending!: Promise<unknown>;
  act(() => {
    pending = requestExportControlAnswer();
  });
  return pending;
}

describe("ExportControlDeclarationDialogHost", () => {
  it("has no default answer and resolves the chosen not_controlled answer", async () => {
    render(<ExportControlDeclarationDialogHost />);
    const pending = openPrompt();

    const continueButton = await screen.findByRole("button", { name: "Continue upload" });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /Not export-controlled/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue upload" }));

    await expect(pending).resolves.toBe("not_controlled");
  });

  it.each([
    [/^Export-controlled/, "controlled"],
    [/I'm not sure/, "unsure"],
  ])("explains the block for %s and resolves %s", async (label, answer) => {
    render(<ExportControlDeclarationDialogHost />);
    const pending = openPrompt();

    fireEvent.click(await screen.findByRole("radio", { name: label }));
    expect(screen.getByRole("alert").textContent).toContain("Nothing was uploaded");
    fireEvent.click(screen.getByRole("button", { name: "Stop upload" }));

    await expect(pending).resolves.toBe(answer);
  });

  it("says the answer covers every file on the part", async () => {
    render(<ExportControlDeclarationDialogHost />);
    openPrompt();

    expect(await screen.findByText("Are any files on this part export-controlled?")).toBeTruthy();
    expect(screen.getByText(/covers every file on this part: files already uploaded and any you add later/)).toBeTruthy();
  });

  it("declares an existing part without uploading and records every answer", async () => {
    render(<ExportControlDeclarationDialogHost />);
    let pending!: Promise<unknown>;
    act(() => {
      pending = requestExportControlAnswer("declare");
    });

    const save = await screen.findByRole("button", { name: "Save answer" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Continue upload" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /I'm not sure/ }));
    expect(screen.getByRole("alert").textContent).toContain("will not be sent to any supplier");
    fireEvent.click(save);

    await expect(pending).resolves.toBe("unsure");
  });

  it("names the files and counts the parts when one answer covers more than one file set", async () => {
    render(<ExportControlDeclarationDialogHost />);
    act(() => {
      void requestExportControlAnswer("upload", {
        fileNames: ["alpha.step", "alpha.pdf", "beta.step", "gamma.step", "delta.step"],
        fileSetCount: 4,
      });
    });

    expect(await screen.findByText("Are any of these files export-controlled?")).toBeTruthy();
    expect(screen.queryByText("Are any files on this part export-controlled?")).toBeNull();
    expect(
      screen.getByText(/This answer applies to all 5 files on 4 parts: alpha\.step, alpha\.pdf, beta\.step, gamma\.step and 1 more\./),
    ).toBeTruthy();
    expect(screen.getByText(/recorded for each of those parts/)).toBeTruthy();
  });

  it("names the files of a single part when more than one file is uploaded", async () => {
    render(<ExportControlDeclarationDialogHost />);
    act(() => {
      void requestExportControlAnswer("upload", { fileNames: ["bracket.step", "bracket.pdf"], fileSetCount: 1 });
    });

    expect(await screen.findByText("Are any files on this part export-controlled?")).toBeTruthy();
    expect(screen.getByText(/This answer applies to all 2 files: bracket\.step, bracket\.pdf\./)).toBeTruthy();
  });

  it("resolves null when cancelled", async () => {
    render(<ExportControlDeclarationDialogHost />);
    const pending = openPrompt();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await expect(pending).resolves.toBeNull();
  });

  it("stops answering after unmount", async () => {
    const { unmount } = render(<ExportControlDeclarationDialogHost />);
    unmount();

    await expect(requestExportControlAnswer()).resolves.toBeNull();
  });
});
