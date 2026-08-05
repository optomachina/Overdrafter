import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CadPreviewThumbnail } from "./CadPreviewThumbnail";
import { downloadStoredFileBlob } from "@/lib/stored-file";
import type { CadPreviewAssetRecord } from "@/features/quotes/types";

vi.mock("@/components/CadIsoThumbnail", () => ({
  CadIsoThumbnail: () => <span data-testid="local-cad-preview">Local preview</span>,
}));

vi.mock("@/lib/stored-file", () => ({
  downloadStoredFileBlob: vi.fn(),
}));

const asset = {
  id: "preview-1",
  part_id: "part-1",
  organization_id: "org-1",
  source_cad_file_id: "file-1",
  source_content_sha256: "hash-1",
  display_style: "sketch",
  view_orientation: "isometric",
  renderer_version: "cad-svg-sketch-v1",
  storage_bucket: "quote-artifacts",
  storage_path: "org-1/cad-previews/job-1/part-1/preview.svg",
  mime_type: "image/svg+xml",
  width: 256,
  height: 256,
  generated_at: "2026-08-05T00:00:00.000Z",
  created_at: "2026-08-05T00:00:00.000Z",
  updated_at: "2026-08-05T00:00:00.000Z",
} satisfies CadPreviewAssetRecord;

describe("CadPreviewThumbnail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces the local fallback after the persisted preview loads", async () => {
    vi.mocked(downloadStoredFileBlob).mockResolvedValue(new Blob(["<svg/>"]));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:persistent-cad-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    render(
      <CadPreviewThumbnail
        asset={asset}
        fallbackSource={{
          cacheKey: "file-1",
          fileName: "part.step",
          loadStepBuffer: async () => new Uint8Array(),
        }}
      />,
    );

    expect(screen.getByTestId("local-cad-preview")).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Isometric CAD sketch preview" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("local-cad-preview")).not.toBeInTheDocument());
  });

  it("keeps the local renderer when no persistent asset exists", () => {
    render(
      <CadPreviewThumbnail
        asset={null}
        fallbackSource={{
          cacheKey: "file-1",
          fileName: "part.step",
          loadStepBuffer: async () => new Uint8Array(),
        }}
      />,
    );

    expect(screen.getByTestId("local-cad-preview")).toBeInTheDocument();
    expect(downloadStoredFileBlob).not.toHaveBeenCalled();
  });
});
