import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchExtractionModelCatalog,
  previewStoredPartExtraction,
  requestExtractionModelCatalogRefresh,
} from "./worker-api";

const originalFetch = global.fetch;

describe("worker-api", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_WORKER_BASE_URL", "http://127.0.0.1:8081");
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
  });

  it("fetches the cached extraction model catalog", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ provider: "openai", modelId: "gpt-5.4" }],
        refreshing: false,
      }),
    });

    await expect(fetchExtractionModelCatalog()).resolves.toMatchObject({
      models: [{ provider: "openai", modelId: "gpt-5.4" }],
      refreshing: false,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8081/debug/extraction/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("requests a background model refresh", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        accepted: true,
        catalog: { models: [] },
      }),
    });

    await expect(requestExtractionModelCatalogRefresh()).resolves.toMatchObject({
      accepted: true,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8081/debug/extraction/models/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("requests a read-only preview for a stored part", async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        partId: "part-1",
        effectiveModel: "claude-sonnet-4-6",
      }),
    });

    await expect(previewStoredPartExtraction("part-1", "claude-sonnet-4-6")).resolves.toMatchObject({
      partId: "part-1",
      effectiveModel: "claude-sonnet-4-6",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8081/debug/extraction/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ partId: "part-1", modelId: "claude-sonnet-4-6" }),
      }),
    );
  });
});
