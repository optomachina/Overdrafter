import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobFileRecord, StagedFile, VendorArtifact, WorkerConfig } from "./types.js";

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function createRunDir(config: WorkerConfig, segments: string[]) {
  const target = path.join(config.workerTempDir, ...segments);
  await ensureDir(target);
  return target;
}

export async function stageStorageObject(
  supabase: SupabaseClient,
  file: JobFileRecord | null,
  targetDir: string,
): Promise<StagedFile | null> {
  if (!file) {
    return null;
  }

  const { data, error } = await supabase.storage.from(file.storage_bucket).download(file.storage_path);

  if (error || !data) {
    throw error ?? new Error(`Failed to download storage object ${file.storage_path}.`);
  }

  const localPath = path.join(targetDir, sanitizeFileName(file.original_name));
  const buffer = Buffer.from(await data.arrayBuffer());

  await fs.writeFile(localPath, buffer);

  return {
    originalName: file.original_name,
    localPath,
    storageBucket: file.storage_bucket,
    storagePath: file.storage_path,
  };
}

function extensionForArtifact(artifact: VendorArtifact) {
  switch (artifact.kind) {
    case "screenshot":
      return ".png";
    case "html_snapshot":
      return ".html";
    case "trace":
      return ".zip";
    case "json":
      return ".json";
    default:
      return "";
  }
}

export async function uploadArtifact(
  supabase: SupabaseClient,
  config: WorkerConfig,
  input: {
    vendorQuoteResultId: string;
    organizationId: string;
    quoteRunId: string;
    partId: string;
    vendor: string;
    artifact: VendorArtifact;
  },
) {
  const artifactBuffer = await fs.readFile(input.artifact.localPath);
  const fileName = `${input.quoteRunId}/${input.partId}/${input.vendor}/${Date.now()}-${sanitizeFileName(
    input.artifact.label,
  )}${extensionForArtifact(input.artifact)}`;
  const storagePath = `${input.organizationId}/${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from(config.artifactBucket)
    .upload(storagePath, artifactBuffer, {
      contentType: input.artifact.contentType,
      upsert: true,
    });

  if (uploadError) {
    throw uploadError;
  }

  const { error: insertError } = await supabase.from("vendor_quote_artifacts").insert({
    vendor_quote_result_id: input.vendorQuoteResultId,
    organization_id: input.organizationId,
    artifact_type: input.artifact.kind,
    storage_bucket: config.artifactBucket,
    storage_path: storagePath,
    metadata: {
      label: input.artifact.label,
      sourceLocalPath: input.artifact.localPath,
      uploadedAt: new Date().toISOString(),
    },
  });

  if (insertError) {
    throw insertError;
  }

  return storagePath;
}

export async function cleanupPaths(paths: Array<string | null | undefined>) {
  await Promise.all(
    paths
      .filter((value): value is string => Boolean(value))
      .map(async (filePath) => {
        try {
          await fs.rm(filePath, { recursive: true, force: true });
        } catch {
          // Best effort cleanup.
        }
      }),
  );
}

export function uniqueName(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}
