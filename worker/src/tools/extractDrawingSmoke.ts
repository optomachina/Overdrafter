import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnvBooleanLike, parseEnvList } from "../env.js";
import { runHybridExtraction } from "../extraction/hybridExtraction.js";
import {
  extractPdfText,
  renderPdfFirstPagePreview,
  renderPdfPreviewAssets,
} from "../extraction/pdfDrawing.js";
import type { JobFileRecord, PartRecord, WorkerConfig } from "../types.js";

function parseArgs() {
  const [, , pdfPathArg] = process.argv;

  if (!pdfPathArg) {
    throw new Error("Usage: npm --prefix worker run extract:smoke -- /absolute/path/to/drawing.pdf");
  }

  return {
    pdfPath: path.resolve(pdfPathArg),
  };
}

function buildSmokeConfig(): WorkerConfig {
  const openAiApiKey = process.env.OPENAI_API_KEY ?? null;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? null;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? null;

  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "simulate",
    workerLiveAdapters: ["xometry"],
    workerName: "drawing-smoke",
    pollIntervalMs: 1000,
    httpHost: "127.0.0.1",
    httpPort: 8080,
    workerTempDir: path.join(os.tmpdir(), "overdrafter-worker"),
    artifactBucket: "quote-artifacts",
    playwrightHeadless: true,
    playwrightCaptureTrace: false,
    browserTimeoutMs: 30000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: null,
    xometryStorageStateJson: null,
    xometryUserDataDir: null,
    xometryBrowserChannel: null,
    fictivStorageStatePath: null,
    fictivStorageStateJson: null,
    openAiApiKey,
    anthropicApiKey,
    openRouterApiKey,
    workerBuildVersion: process.env.WORKER_BUILD_VERSION ?? "smoke-local",
    drawingExtractionModel: process.env.DRAWING_EXTRACTION_MODEL ?? "gpt-5.4",
    drawingExtractionEnableModelFallback: parseEnvBooleanLike(
      process.env.DRAWING_EXTRACTION_ENABLE_MODEL_FALLBACK,
      Boolean(openAiApiKey),
    ),
    drawingExtractionDebugAllowedModels: parseEnvList(
      process.env.DRAWING_EXTRACTION_DEBUG_ALLOWED_MODELS,
      process.env.DRAWING_EXTRACTION_MODEL ?? "gpt-5.4",
    ),
  };
}

async function main() {
  const { pdfPath } = parseArgs();
  await fs.access(pdfPath);

  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-drawing-smoke-"));
  const pdfText = await extractPdfText(pdfPath);
  let previewAssets =
    pdfText && pdfText.pageCount > 0 ? await renderPdfPreviewAssets(pdfPath, runDir, pdfText.pageCount) : [];
  let firstPagePreview = previewAssets.find((asset) => asset.kind === "page" && asset.pageNumber === 1) ?? null;

  if (!firstPagePreview) {
    firstPagePreview = await renderPdfFirstPagePreview(pdfPath, path.join(runDir, "drawing-page-1.png"));

    if (firstPagePreview) {
      previewAssets = [
        ...previewAssets.filter(
          (asset) => !(asset.kind === "page" && asset.pageNumber === firstPagePreview?.pageNumber),
        ),
        firstPagePreview,
      ];
    }
  }

  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  const part: PartRecord = {
    id: "smoke-part",
    job_id: "smoke-job",
    organization_id: "smoke-org",
    name: baseName,
    normalized_key: baseName.toLowerCase(),
    cad_file_id: null,
    drawing_file_id: "smoke-drawing",
    quantity: 1,
  };
  const drawingFile: JobFileRecord = {
    id: "smoke-drawing",
    job_id: "smoke-job",
    storage_bucket: "local",
    storage_path: pdfPath,
    original_name: path.basename(pdfPath),
    file_kind: "drawing",
  };

  const extraction = await runHybridExtraction({
    part,
    cadFile: null,
    drawingFile,
    pdfText,
    drawingPath: pdfPath,
    previewPagePath: firstPagePreview?.localPath ?? null,
    runDir,
    config: buildSmokeConfig(),
  });

  console.log(
    JSON.stringify(
      {
        pdfPath,
        runDir,
        pdfTextPageCount: pdfText?.pageCount ?? 0,
        previewAssetCount: previewAssets.length,
        previewPagePath: firstPagePreview?.localPath ?? null,
        extraction,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
