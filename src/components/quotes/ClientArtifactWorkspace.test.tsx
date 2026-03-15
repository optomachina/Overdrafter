import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientArtifactWorkspace } from "./ClientArtifactWorkspace";

describe("ClientArtifactWorkspace", () => {
  it("defaults to split when both CAD and drawing are available", () => {
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
    expect(screen.getByText("DRAWING PANEL")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /split/i })).toHaveAttribute("aria-selected", "true");
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
    expect(screen.getByRole("tab", { name: /split/i })).toBeDisabled();
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

    expect(screen.getByText("CAD model not available")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /drawing/i })).toBeDisabled();
    expect(screen.getByRole("tab", { name: /split/i })).toBeDisabled();
  });
});
