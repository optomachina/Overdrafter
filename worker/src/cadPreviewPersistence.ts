import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CAD_PREVIEW_DISPLAY_STYLE,
  CAD_PREVIEW_ORIENTATION,
  CAD_PREVIEW_RENDERER_VERSION,
  renderCadPreviewFromStepFile,
} from "./cadPreview.js";
import { stageStorageObject } from "./files.js";
import type { JobFileRecord, WorkerConfig } from "./types.js";

type ExistingCadPreviewAsset = {
  source_cad_file_id: string;
  source_content_sha256: string | null;
  renderer_version: string;
};

export type CadPreviewPersistenceResult = {
  status: "current" | "generated" | "skipped";
  storagePath: string | null;
  triangleCount: number;
  featureEdgeCount: number;
};

/**
 * Schedules one dedicated preview attempt after inline extraction rendering
 * fails, without duplicating preview work that is already queued or running.
 */
export async function enqueueCadPreviewGenerationTask(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    jobId: string;
    partId: string;
    cadFileId: string | null;
    source: string;
  },
): Promise<boolean> {
  const { data: existingTasks, error: existingTaskError } = await supabase
    .from("work_queue")
    .select("id")
    .eq("part_id", input.partId)
    .eq("task_type", "generate_cad_preview")
    .in("status", ["queued", "running"])
    .limit(1);

  if (existingTaskError) {
    throw existingTaskError;
  }

  if (existingTasks && existingTasks.length > 0) {
    return false;
  }

  const { error: insertError } = await supabase.from("work_queue").insert({
    organization_id: input.organizationId,
    job_id: input.jobId,
    part_id: input.partId,
    task_type: "generate_cad_preview",
    status: "queued",
    payload: {
      source: input.source,
      partId: input.partId,
      jobId: input.jobId,
      cadFileId: input.cadFileId,
    },
  });

  if (insertError) {
    throw insertError;
  }

  return true;
}

export function isStepCadFile(file: Pick<JobFileRecord, "original_name">): boolean {
  return /\.(step|stp)$/i.test(file.original_name.trim());
}

/**
 * Generates and atomically projects the current part/CAD relationship into one
 * persistent sketch asset. The stable path prevents revision
 * changes from leaking obsolete storage objects.
 */
export async function ensurePersistentCadPreview(
  supabase: SupabaseClient,
  config: WorkerConfig,
  input: {
    organizationId: string;
    jobId: string;
    partId: string;
    cadFile: JobFileRecord | null;
    runDir: string;
  },
): Promise<CadPreviewPersistenceResult> {
  if (!input.cadFile || !isStepCadFile(input.cadFile)) {
    return {
      status: "skipped",
      storagePath: null,
      triangleCount: 0,
      featureEdgeCount: 0,
    };
  }

  const { data: existingAsset, error: existingAssetError } = await supabase
    .from("cad_preview_assets")
    .select("source_cad_file_id, source_content_sha256, renderer_version")
    .eq("part_id", input.partId)
    .eq("display_style", CAD_PREVIEW_DISPLAY_STYLE)
    .eq("view_orientation", CAD_PREVIEW_ORIENTATION)
    .maybeSingle();

  if (existingAssetError) {
    throw existingAssetError;
  }

  if (isCurrentAsset(existingAsset as ExistingCadPreviewAsset | null, input.cadFile)) {
    return {
      status: "current",
      storagePath: null,
      triangleCount: 0,
      featureEdgeCount: 0,
    };
  }

  const stagedCadFile = await stageStorageObject(supabase, input.cadFile, input.runDir);
  if (!stagedCadFile) {
    throw new Error(`CAD file ${input.cadFile.id} could not be staged for preview generation.`);
  }

  const preview = await renderCadPreviewFromStepFile(stagedCadFile.localPath);
  const storagePath = [
    input.organizationId,
    "cad-previews",
    input.jobId,
    input.partId,
    "sketch-isometric.svg",
  ].join("/");
  const { error: uploadError } = await supabase.storage
    .from(config.artifactBucket)
    .upload(storagePath, preview.content, {
      contentType: preview.contentType,
      cacheControl: "300",
      upsert: true,
    });

  if (uploadError) {
    throw uploadError;
  }

  const generatedAt = new Date().toISOString();
  const { error: upsertError } = await supabase.from("cad_preview_assets").upsert(
    {
      part_id: input.partId,
      organization_id: input.organizationId,
      source_cad_file_id: input.cadFile.id,
      source_content_sha256: input.cadFile.content_sha256 ?? null,
      display_style: preview.displayStyle,
      view_orientation: preview.viewOrientation,
      renderer_version: preview.rendererVersion,
      storage_bucket: config.artifactBucket,
      storage_path: storagePath,
      mime_type: preview.contentType,
      width: preview.width,
      height: preview.height,
      generated_at: generatedAt,
    },
    {
      onConflict: "part_id,display_style,view_orientation",
    },
  );

  if (upsertError) {
    throw upsertError;
  }

  return {
    status: "generated",
    storagePath,
    triangleCount: preview.triangleCount,
    featureEdgeCount: preview.featureEdgeCount,
  };
}

function isCurrentAsset(
  asset: ExistingCadPreviewAsset | null,
  cadFile: JobFileRecord,
): boolean {
  if (!asset) {
    return false;
  }

  return (
    asset.source_cad_file_id === cadFile.id &&
    asset.source_content_sha256 === (cadFile.content_sha256 ?? null) &&
    asset.renderer_version === CAD_PREVIEW_RENDERER_VERSION
  );
}
