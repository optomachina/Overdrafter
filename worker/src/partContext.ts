import type { PostgrestResponse, SupabaseClient } from "@supabase/supabase-js";
import type { ApprovedRequirementRecord, JobFileRecord, PartRecord } from "./types.js";

function emptyResponse<T>(): Promise<PostgrestResponse<T>> {
  return Promise.resolve({
    data: [],
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  });
}

export async function fetchPartContext(supabase: SupabaseClient, partId: string) {
  const { data: part, error: partError } = await supabase
    .from("parts")
    .select("*")
    .eq("id", partId)
    .single();

  if (partError || !part) {
    throw partError ?? new Error(`Part ${partId} not found.`);
  }

  const fileIds = [part.cad_file_id, part.drawing_file_id].filter(Boolean) as string[];
  const [{ data: files, error: fileError }, { data: requirement, error: requirementError }] =
    await Promise.all([
      fileIds.length
        ? supabase.from("job_files").select("*").in("id", fileIds)
        : emptyResponse<JobFileRecord>(),
      supabase.from("approved_part_requirements").select("*").eq("part_id", partId).maybeSingle(),
    ]);

  if (fileError) {
    throw fileError;
  }

  if (requirementError && requirementError.code !== "PGRST116") {
    throw requirementError;
  }

  const cadFile =
    (files as JobFileRecord[]).find((file) => file.id === part.cad_file_id) ?? null;
  const drawingFile =
    (files as JobFileRecord[]).find((file) => file.id === part.drawing_file_id) ?? null;

  return {
    part: part as PartRecord,
    cadFile,
    drawingFile,
    requirement: (requirement as ApprovedRequirementRecord | null) ?? null,
  };
}
