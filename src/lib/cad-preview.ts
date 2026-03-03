import type { OcctReadResult } from "occt-import-js";
import type { JobFileRecord } from "@/features/quotes/types";
import { supabase } from "@/integrations/supabase/client";
import { getOcctImportModule } from "@/lib/occt-import";

const STEP_FILE_EXTENSIONS = new Set(["step", "stp"]);

const cadFileBufferCache = new Map<string, Promise<Uint8Array>>();
const cadPreviewResultCache = new Map<string, Promise<OcctReadResult>>();

export type CadPreviewSource = {
  cacheKey: string;
  fileName: string;
  loadStepBuffer: () => Promise<Uint8Array>;
};

export function isStepPreviewableFile(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return STEP_FILE_EXTENSIONS.has(extension);
}

export function createCadPreviewSourceFromFile(file: File): CadPreviewSource {
  const cacheKey = `local:${file.name}:${file.size}:${file.lastModified}`;

  return {
    cacheKey,
    fileName: file.name,
    loadStepBuffer: () =>
      getOrCreateCacheEntry(cadFileBufferCache, cacheKey, async () => new Uint8Array(await file.arrayBuffer())),
  };
}

export function createCadPreviewSourceFromJobFile(
  file: Pick<JobFileRecord, "id" | "original_name" | "storage_bucket" | "storage_path">,
): CadPreviewSource {
  const cacheKey = `job-file:${file.id}:${file.storage_bucket}:${file.storage_path}`;

  return {
    cacheKey,
    fileName: file.original_name,
    loadStepBuffer: () =>
      getOrCreateCacheEntry(cadFileBufferCache, cacheKey, async () => {
        const { data, error } = await supabase.storage.from(file.storage_bucket).download(file.storage_path);

        if (error) {
          throw error;
        }

        if (!data) {
          throw new Error(`Stored CAD file ${file.original_name} could not be downloaded.`);
        }

        return new Uint8Array(await data.arrayBuffer());
      }),
  };
}

export function loadCadPreview(source: CadPreviewSource): Promise<OcctReadResult> {
  if (!isStepPreviewableFile(source.fileName)) {
    return Promise.reject(new Error("Preview only supports STEP files."));
  }

  return getOrCreateCacheEntry(cadPreviewResultCache, source.cacheKey, async () => {
    const [occt, stepContent] = await Promise.all([getOcctImportModule(), source.loadStepBuffer()]);

    const result = occt.ReadStepFile(stepContent, {
      linearUnit: "millimeter",
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: 0.0025,
      angularDeflection: 0.35,
    });

    if (!result.success || result.meshes.length === 0) {
      throw new Error("The STEP file could not be triangulated for preview.");
    }

    return result;
  });
}

function getOrCreateCacheEntry<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);

  if (existing) {
    return existing;
  }

  const pending = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });

  cache.set(key, pending);

  return pending;
}
