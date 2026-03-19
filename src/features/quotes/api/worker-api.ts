import type { WorkerReadinessSnapshot } from "@/features/quotes/types";

export async function fetchWorkerReadiness(): Promise<WorkerReadinessSnapshot> {
  const baseUrl = import.meta.env.VITE_WORKER_BASE_URL?.trim();

  if (!baseUrl) {
    return {
      reachable: false,
      ready: null,
      workerName: null,
      workerBuildVersion: null,
      workerMode: null,
      drawingExtractionModel: null,
      drawingExtractionDebugAllowedModels: [],
      drawingExtractionModelFallbackEnabled: false,
      status: null,
      readinessIssues: [],
      message: "Set VITE_WORKER_BASE_URL to enable the worker readiness probe.",
      url: null,
    };
  }

  const targetUrl = new URL("/readyz", baseUrl).toString();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
    });
    const payload = (await response.json()) as Record<string, unknown>;

    return {
      reachable: true,
      ready: typeof payload.ready === "boolean" ? payload.ready : response.ok,
      workerName: typeof payload.workerName === "string" ? payload.workerName : null,
      workerBuildVersion: typeof payload.workerBuildVersion === "string" ? payload.workerBuildVersion : null,
      workerMode: typeof payload.workerMode === "string" ? payload.workerMode : null,
      drawingExtractionModel:
        typeof payload.drawingExtractionModel === "string" ? payload.drawingExtractionModel : null,
      drawingExtractionDebugAllowedModels: Array.isArray(payload.drawingExtractionDebugAllowedModels)
        ? payload.drawingExtractionDebugAllowedModels.map(String)
        : [],
      drawingExtractionModelFallbackEnabled: Boolean(payload.drawingExtractionModelFallbackEnabled),
      status: typeof payload.status === "string" ? payload.status : null,
      readinessIssues: Array.isArray(payload.readinessIssues)
        ? payload.readinessIssues.map(String)
        : [],
      message: response.ok ? null : `Worker readiness probe returned HTTP ${response.status}.`,
      url: targetUrl,
    };
  } catch (error) {
    return {
      reachable: false,
      ready: null,
      workerName: null,
      workerBuildVersion: null,
      workerMode: null,
      drawingExtractionModel: null,
      drawingExtractionDebugAllowedModels: [],
      drawingExtractionModelFallbackEnabled: false,
      status: null,
      readinessIssues: [],
      message: error instanceof Error ? error.message : "Unable to reach the worker readiness probe.",
      url: targetUrl,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}
