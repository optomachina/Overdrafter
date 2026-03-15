import { beforeEach, describe, expect, it, vi } from "vitest";

const storageDownload = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: vi.fn(() => ({
        download: storageDownload,
      })),
    },
  },
}));

import { downloadStoredFileBlob } from "./stored-file";

describe("stored-file", () => {
  beforeEach(() => {
    storageDownload.mockReset();
  });

  it("wraps storage errors in a real Error with a readable message", async () => {
    storageDownload.mockResolvedValue({
      data: null,
      error: {
        name: "StorageApiError",
        code: "403",
        status: 403,
        details: "Access denied",
      },
    });

    await expect(
      downloadStoredFileBlob({
        storage_bucket: "quote-artifacts",
        storage_path: "preview/page-1.png",
        original_name: "drawing.pdf",
      }),
    ).rejects.toMatchObject({
      name: "StorageApiError",
      message: '{"name":"StorageApiError","code":"403","status":403,"details":"Access denied"}',
      code: "403",
      status: 403,
      details: "Access denied",
    });
  });
});
