#!/usr/bin/env node
/**
 * Saves an agent-generated CAD part into OverDrafter as a normal part in the
 * signed-in user's account.
 *
 * It runs as the user (their own Supabase session, never a service-role key)
 * and calls the same RPC sequence as the browser upload in
 * src/features/quotes/api/uploads-api.ts:
 *
 *   api_create_client_draft -> api_declare_job_export_status ->
 *   api_prepare_job_file_upload -> storage upload -> api_finalize_job_file_upload ->
 *   api_reconcile_job_parts -> api_request_extraction
 *
 * so RLS, extraction, quoting, archive and delete behave exactly like an upload.
 * The part is marked with the tags "source:generated" and "generator:<name>".
 *
 * Usage:
 *   node scripts/ingest-generated-part.mjs --step part.step --name "Bracket" \
 *     [--spec-file spec.json | --spec "text"] [--thumbnail part.png] \
 *     [--project-id <uuid>] [--generator cad-monkey] --export-control not_controlled
 *
 * Export control: the browser asks the human. Here the user attests once, by
 * setting OVERDRAFTER_EXPORT_ATTESTATION=not_controlled in the environment the
 * agent runs in; the --export-control flag must match it. An agent cannot
 * attest on its own. If any step after the draft is created fails, the empty
 * draft stays in the workspace and can be archived and deleted like any draft.
 *
 * Environment: OVERDRAFTER_SUPABASE_URL, OVERDRAFTER_SUPABASE_ANON_KEY (public),
 * OVERDRAFTER_USER_SESSION_FILE: a JSON file holding the user's refresh_token.
 * The rotated refresh token is written back to that file (mode 0600). Tokens
 * are never printed.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

export const GENERATED_SOURCE_TAG = "source:generated";
export const GENERATOR_TAG_PREFIX = "generator:";
export const EXPORT_CONTROL_TERMS_VERSION = "ovd-beta-export-control.v1";
const STEP_EXTENSIONS = new Set([".step", ".stp"]);
const MAX_DESCRIPTION_CHARS = 4000;

export function buildGeneratedTags(generator) {
  const clean = String(generator ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return clean ? [GENERATED_SOURCE_TAG, `${GENERATOR_TAG_PREFIX}${clean}`] : [GENERATED_SOURCE_TAG];
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Same rule as isStorageObjectExistsError in uploads-api.ts. */
export function isStorageObjectExistsError(error) {
  if (!error || typeof error !== "object") return false;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  const errorCode = typeof error.error === "string" ? error.error.toLowerCase() : "";
  const statusCode = typeof error.statusCode === "string" ? error.statusCode : "";
  return statusCode === "409" || message.includes("already exists") || message.includes("duplicate") || errorCode.includes("duplicate");
}

export function thumbnailMimeType(fileName) {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  throw new Error("Thumbnail must be a .png or .jpg file.");
}

function unwrap(response, step) {
  if (response?.error) {
    const message = typeof response.error.message === "string" ? response.error.message : "unknown error";
    throw new Error(`${step} failed: ${message}`);
  }
  return response?.data;
}

/**
 * @param {object} input
 * @param {{ rpc: Function, storage: { from: Function } }} input.client user-scoped Supabase client
 * @param {string} input.name
 * @param {string|null} input.specText
 * @param {string} input.generator
 * @param {string|null} input.projectId
 * @param {"not_controlled"} input.exportControl the user's declaration
 * @param {Array<{ name: string, bytes: Uint8Array, kind: "cad"|"other", mimeType: string|null }>} input.files
 */
export async function ingestGeneratedPart(input) {
  const { client, files } = input;
  if (input.exportControl !== "not_controlled") {
    throw new Error("Refusing to upload: pass --export-control not_controlled only when the part is not export-controlled.");
  }
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("A part name is required.");
  const cadFiles = files.filter((file) => file.kind === "cad");
  if (cadFiles.length !== 1 || !STEP_EXTENSIONS.has(extname(cadFiles[0].name).toLowerCase())) {
    throw new Error("Exactly one STEP file (.step/.stp) is required.");
  }

  const description = input.specText ? String(input.specText).slice(0, MAX_DESCRIPTION_CHARS) : null;
  const jobId = unwrap(
    await client.rpc("api_create_client_draft", {
      p_title: name,
      p_description: description,
      p_project_id: input.projectId ?? null,
      p_tags: buildGeneratedTags(input.generator),
      p_requested_service_kinds: [],
      p_primary_service_kind: null,
      p_service_notes: null,
      p_requested_quote_quantities: [],
      p_requested_by_date: null,
    }),
    "api_create_client_draft",
  );
  if (typeof jobId !== "string" || !jobId) throw new Error("api_create_client_draft returned no job id.");

  const declaration = unwrap(
    await client.rpc("api_declare_job_export_status", {
      p_job_id: jobId,
      p_answer: "not_controlled",
      p_terms_version: EXPORT_CONTROL_TERMS_VERSION,
    }),
    "api_declare_job_export_status",
  );
  const declarationId = declaration?.declarationId;
  if (declaration?.uploadAllowed !== true || typeof declarationId !== "string" || !declarationId) {
    throw new Error(`Upload blocked: ${declaration?.reasonCode ?? "export_declaration_missing"}`);
  }

  const uploaded = [];
  for (const file of files) {
    const contentSha256 = sha256Hex(file.bytes);
    const common = {
      p_job_id: jobId,
      p_original_name: file.name,
      p_file_kind: file.kind,
      p_mime_type: file.mimeType,
      p_size_bytes: file.bytes.byteLength,
      p_content_sha256: contentSha256,
      p_export_declaration_id: declarationId,
    };
    const prepared = unwrap(await client.rpc("api_prepare_job_file_upload", common), `prepare ${file.name}`);
    if (prepared?.status === "duplicate_in_job" || prepared?.status === "reused") {
      uploaded.push({ name: file.name, status: prepared.status });
      continue;
    }
    const { error: storageError } = await client.storage
      .from(prepared.storageBucket)
      .upload(prepared.storagePath, file.bytes, { upsert: false, contentType: file.mimeType ?? undefined });
    if (storageError && !isStorageObjectExistsError(storageError)) {
      throw new Error(`storage upload ${file.name} failed: ${storageError.message}`);
    }
    unwrap(
      await client.rpc("api_finalize_job_file_upload", {
        ...common,
        p_storage_bucket: prepared.storageBucket,
        p_storage_path: prepared.storagePath,
      }),
      `finalize ${file.name}`,
    );
    uploaded.push({ name: file.name, status: "uploaded" });
  }

  unwrap(await client.rpc("api_reconcile_job_parts", { p_job_id: jobId }), "api_reconcile_job_parts");
  unwrap(await client.rpc("api_request_extraction", { p_job_id: jobId }), "api_request_extraction");
  return { jobId, files: uploaded };
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.OVERDRAFTER_SUPABASE_URL;
  const anonKey = process.env.OVERDRAFTER_SUPABASE_ANON_KEY;
  const sessionFile = process.env.OVERDRAFTER_USER_SESSION_FILE;
  if (!url || !anonKey || !sessionFile) {
    throw new Error("Set OVERDRAFTER_SUPABASE_URL, OVERDRAFTER_SUPABASE_ANON_KEY and OVERDRAFTER_USER_SESSION_FILE.");
  }
  if (!args.step || !args.name) throw new Error("--step and --name are required.");

  if (process.env.OVERDRAFTER_EXPORT_ATTESTATION !== "not_controlled" || args["export-control"] !== "not_controlled") {
    throw new Error("Export-control attestation missing: the user must set OVERDRAFTER_EXPORT_ATTESTATION=not_controlled and pass --export-control not_controlled.");
  }
  const sessionStat = await stat(sessionFile);
  if (process.platform !== "win32" && (sessionStat.mode & 0o077) !== 0) {
    throw new Error("The session file must be readable only by its owner (chmod 600).");
  }

  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const stored = JSON.parse(await readFile(sessionFile, "utf8"));
  const { data, error } = await client.auth.refreshSession({ refresh_token: stored.refresh_token });
  if (error || !data.session) throw new Error("Could not sign in as the user; re-create the session file.");
  // Write the rotated token atomically so a failed write cannot lose it.
  const tmpFile = `${sessionFile}.tmp`;
  await writeFile(tmpFile, JSON.stringify({ refresh_token: data.session.refresh_token }), { mode: 0o600 });
  await rename(tmpFile, sessionFile);

  const files = [{ name: basename(args.step), bytes: await readFile(args.step), kind: "cad", mimeType: "model/step" }];
  if (args.thumbnail) {
    files.push({ name: basename(args.thumbnail), bytes: await readFile(args.thumbnail), kind: "other", mimeType: thumbnailMimeType(args.thumbnail) });
  }
  const specText = args["spec-file"] ? await readFile(args["spec-file"], "utf8") : (args.spec ?? null);

  const result = await ingestGeneratedPart({
    client,
    name: args.name,
    specText,
    generator: args.generator ?? "cad-monkey",
    projectId: args["project-id"] ?? null,
    exportControl: args["export-control"],
    files,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
