import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CadModelThumbnail } from "./CadModelThumbnail";
import { loadCadPreview } from "@/lib/cad-preview";

vi.mock("@/lib/cad-preview", () => ({
  isStepPreviewableFile: (fileName: string) =>
    fileName.toLowerCase().endsWith(".step") || fileName.toLowerCase().endsWith(".stp"),
  loadCadPreview: vi.fn(),
}));

describe("CadModelThumbnail", () => {
  it("shows explicit WebGL fallback copy and action button when preview initialization fails", async () => {
    vi.mocked(loadCadPreview).mockRejectedValueOnce(new Error("WebGL context creation failed"));
    const onFallbackAction = vi.fn();

    render(
      <CadModelThumbnail
        source={{
          cacheKey: "test-step",
          fileName: "bracket.step",
          loadStepBuffer: async () => new Uint8Array(),
        }}
        onFallbackAction={onFallbackAction}
        fallbackActionLabel="Download bracket.step"
      />,
    );

    expect(await screen.findByText(/3d preview is unavailable in this browser/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Download bracket.step" }));
    expect(onFallbackAction).toHaveBeenCalledTimes(1);
  });

  it("keeps existing non-STEP fallback behavior", () => {
    render(
      <CadModelThumbnail
        source={{
          cacheKey: "test-iges",
          fileName: "fixture.iges",
          loadStepBuffer: async () => new Uint8Array(),
        }}
      />,
    );

    expect(screen.getByText("Preview only supports STEP files.")).toBeInTheDocument();
    expect(loadCadPreview).not.toHaveBeenCalled();
  });
});
