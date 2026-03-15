import { supabase } from "@/integrations/supabase/client";
import { toUserFacingError } from "@/lib/error-message";

export const FIXTURE_STORAGE_BUCKET = "fixture-public";

type StoredFileLike = {
  storage_bucket: string;
  storage_path: string;
  original_name?: string | null;
};

function resolveFixtureAssetUrl(storagePath: string): string {
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
    return storagePath;
  }

  return storagePath.startsWith("/") ? storagePath : `/${storagePath}`;
}

export function isFixtureStoredFile(file: Pick<StoredFileLike, "storage_bucket">): boolean {
  return file.storage_bucket === FIXTURE_STORAGE_BUCKET;
}

export async function downloadStoredFileBlob(file: StoredFileLike): Promise<Blob> {
  if (isFixtureStoredFile(file)) {
    const response = await fetch(resolveFixtureAssetUrl(file.storage_path));

    if (!response.ok) {
      throw new Error(`Unable to download ${file.original_name ?? file.storage_path}.`);
    }

    return await response.blob();
  }

  const { data, error } = await supabase.storage.from(file.storage_bucket).download(file.storage_path);

  if (error || !data) {
    throw toUserFacingError(
      error,
      `Unable to download ${file.original_name ?? file.storage_path}.`,
    );
  }

  return data;
}

export async function downloadStoredFileBytes(file: StoredFileLike): Promise<Uint8Array> {
  const blob = await downloadStoredFileBlob(file);
  return new Uint8Array(await blob.arrayBuffer());
}
