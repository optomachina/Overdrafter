import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueCadPreviewGenerationTask,
  ensurePersistentCadPreview,
} from "./cadPreviewPersistence";
import { CAD_PREVIEW_RENDERER_VERSION, renderCadPreviewFromStepFile } from "./cadPreview";
import { stageStorageObject } from "./files";
import type { JobFileRecord, WorkerConfig } from "./types";

vi.mock("./files.js", () => ({
  stageStorageObject: vi.fn(),
}));

vi.mock("./cadPreview.js", async () => {
  const actual = await vi.importActual<typeof import("./cadPreview")>("./cadPreview");
  return {
    ...actual,
    renderCadPreviewFromStepFile: vi.fn(),
  };
});

const cadFile: JobFileRecord = {
  id: "cad-1",
  job_id: "job-1",
  storage_bucket: "job-files",
  storage_path: "org-1/part.step",
  original_name: "part.step",
  file_kind: "cad",
  content_sha256: "cad-hash",
};

function createSupabaseMock(existingAsset: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: existingAsset, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);

  const upsert = vi.fn().mockResolvedValue({ error: null });
  const upload = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({
    ...query,
    upsert,
  }));

  return {
    client: {
      from,
      storage: {
        from: vi.fn(() => ({ upload })),
      },
    },
    upload,
    upsert,
  };
}

describe("ensurePersistentCadPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips rendering when the current CAD file and renderer already match", async () => {
    const supabase = createSupabaseMock({
      source_cad_file_id: cadFile.id,
      source_content_sha256: cadFile.content_sha256,
      renderer_version: CAD_PREVIEW_RENDERER_VERSION,
    });

    await expect(
      ensurePersistentCadPreview(
        supabase.client as never,
        { artifactBucket: "quote-artifacts" } as WorkerConfig,
        {
          organizationId: "org-1",
          jobId: "job-1",
          partId: "part-1",
          cadFile,
          runDir: "/tmp/cad-preview",
        },
      ),
    ).resolves.toMatchObject({ status: "current" });
    expect(stageStorageObject).not.toHaveBeenCalled();
  });

  it("uploads and upserts a deterministic preview when the asset is stale", async () => {
    const supabase = createSupabaseMock(null);
    vi.mocked(stageStorageObject).mockResolvedValue({
      originalName: "part.step",
      localPath: "/tmp/cad-preview/part.step",
      storageBucket: "job-files",
      storagePath: "org-1/part.step",
    });
    vi.mocked(renderCadPreviewFromStepFile).mockResolvedValue({
      content: Buffer.from("<svg/>", "utf8"),
      contentType: "image/svg+xml",
      displayStyle: "sketch",
      viewOrientation: "isometric",
      rendererVersion: CAD_PREVIEW_RENDERER_VERSION,
      width: 256,
      height: 256,
      triangleCount: 12,
      featureEdgeCount: 8,
    });

    await expect(
      ensurePersistentCadPreview(
        supabase.client as never,
        { artifactBucket: "quote-artifacts" } as WorkerConfig,
        {
          organizationId: "org-1",
          jobId: "job-1",
          partId: "part-1",
          cadFile,
          runDir: "/tmp/cad-preview",
        },
      ),
    ).resolves.toMatchObject({
      status: "generated",
      storagePath: "org-1/cad-previews/job-1/part-1/sketch-isometric.svg",
      triangleCount: 12,
      featureEdgeCount: 8,
    });
    expect(supabase.upload).toHaveBeenCalledWith(
      "org-1/cad-previews/job-1/part-1/sketch-isometric.svg",
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/svg+xml", upsert: true }),
    );
    expect(supabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        part_id: "part-1",
        source_cad_file_id: "cad-1",
        renderer_version: CAD_PREVIEW_RENDERER_VERSION,
      }),
      { onConflict: "part_id,display_style,view_orientation" },
    );
  });
});

describe("enqueueCadPreviewGenerationTask", () => {
  it("queues a dedicated retry when no preview task is active", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn((table: string) => table === "work_queue" ? { insert } : {});

    await expect(
      enqueueCadPreviewGenerationTask({ from } as never, {
        organizationId: "org-1",
        jobId: "job-1",
        partId: "part-1",
        cadFileId: "cad-1",
        source: "extract_part_retry",
      }),
    ).resolves.toBe(true);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: "generate_cad_preview",
        status: "queued",
        payload: expect.objectContaining({ source: "extract_part_retry" }),
      }),
    );
  });

  it("does not duplicate queued preview work", async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: "23505", message: "duplicate active preview task" },
    });
    const from = vi.fn(() => ({ insert }));

    await expect(
      enqueueCadPreviewGenerationTask({ from } as never, {
        organizationId: "org-1",
        jobId: "job-1",
        partId: "part-1",
        cadFileId: "cad-1",
        source: "extract_part_retry",
      }),
    ).resolves.toBe(false);
    expect(insert).toHaveBeenCalledOnce();
  });

  it("surfaces non-conflict enqueue failures", async () => {
    const insertError = { code: "42501", message: "permission denied" };
    const insert = vi.fn().mockResolvedValue({ error: insertError });
    const from = vi.fn(() => ({ insert }));

    await expect(
      enqueueCadPreviewGenerationTask({ from } as never, {
        organizationId: "org-1",
        jobId: "job-1",
        partId: "part-1",
        cadFileId: "cad-1",
        source: "extract_part_retry",
      }),
    ).rejects.toBe(insertError);
  });
});
