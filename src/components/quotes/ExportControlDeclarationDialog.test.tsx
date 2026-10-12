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
