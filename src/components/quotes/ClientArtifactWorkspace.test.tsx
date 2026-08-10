import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientArtifactWorkspace } from "./ClientArtifactWorkspace";

describe("ClientArtifactWorkspace", () => {
  it("defaults to CAD when both CAD and drawing are available", () => {
    render(
      <ClientArtifactWorkspace
        itemKey="job-1"
        hasCad
        hasDrawing
        cadPanel={<div>CAD PANEL</div>}
        drawingPanel={<div>DRAWING PANEL</div>}
      />,
    );

    expect(screen.getByText("CAD PANEL")).toBeInTheDocument();
    expect(screen.queryByText("DRAWING PANEL")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /cad/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /cad/i })).toHaveClass("h-11", "sm:h-8");

    const drawingTab = screen.getByRole("tab", { name: /drawing/i });
    fireEvent.pointerDown(drawingTab, { button: 0, ctrlKey: false });
    fireEvent.mouseDown(drawingTab, { button: 0, ctrlKey: false });
    fireEvent.click(drawingTab);

    expect(screen.getByText("DRAWING PANEL")).toBeInTheDocument();
    expect(screen.queryByText("CAD PANEL")).not.toBeInTheDocument();
  });

  it("defaults to drawing when only a drawing is available and keeps unavailable tabs disabled", () => {
    render(
      <ClientArtifactWorkspace
        itemKey="job-2"
        hasCad={false}
        hasDrawing
        cadPanel={<div>CAD PANEL</div>}
        drawingPanel={<div>DRAWING PANEL</div>}
      />,
    );

    expect(screen.getByText("DRAWING PANEL")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /cad/i })).toBeDisabled();
  });

  it("defaults to drawing while keeping a download-only CAD artifact selectable", () => {
    render(
      <ClientArtifactWorkspace
        itemKey="job-native-cad"
        hasCad
        hasCadPreview={false}
        hasDrawing
        cadPanel={<div>DOWNLOAD NATIVE CAD</div>}
        drawingPanel={<div>DRAWING PANEL</div>}
      />,
    );

    expect(screen.getByText("DRAWING PANEL")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /cad/i })).toBeEnabled();
  });

  it("shows a clean empty state when no artifacts are available", () => {
    render(
      <ClientArtifactWorkspace
        itemKey="job-3"
        hasCad={false}
        hasDrawing={false}
        cadPanel={<div>CAD PANEL</div>}
        drawingPanel={<div>DRAWING PANEL</div>}
      />,
    );

    expect(screen.getByText("Artifacts will appear here")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /drawing/i })).toBeDisabled();
  });
});
