import http from "node:http";
import type { AddressInfo } from "node:net";
import type { QueueTaskType, WorkerConfig } from "./types.js";

type RuntimeStatus = "starting" | "running" | "shutting_down";
type RuntimeEventLevel = "info" | "warn" | "error";
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type TaskSummary = {
  id: string;
  type: QueueTaskType;
};

export type WorkerRuntimeError = {
  name: string;
  message: string;
  stack: string | null;
  code: string | null;
  details: string | null;
  hint: string | null;
};

export type WorkerRuntimeEvent = {
  id: string;
  timestamp: string;
  level: RuntimeEventLevel;
  source: string;
  message: string;
  context: Record<string, JsonValue> | null;
  error: WorkerRuntimeError | null;
};

export type WorkerRuntimeState = {
  startedAt: string;
  status: RuntimeStatus;
  readinessIssues: string[];
  lastLoopAt: string | null;
  lastTaskStartedAt: string | null;
  lastTaskCompletedAt: string | null;
  lastTaskFailedAt: string | null;
  currentTask: TaskSummary | null;
  lastCompletedTask: TaskSummary | null;
  lastFailedTask: TaskSummary | null;
  lastError: string | null;
  lastErrorEvent: WorkerRuntimeEvent | null;
  recentEvents: WorkerRuntimeEvent[];
  eventCounts: Record<RuntimeEventLevel, number>;
};

type WorkerDebugHandlers = {
  getExtractionModels?: () => Promise<Record<string, unknown>>;
  refreshExtractionModels?: () => Promise<Record<string, unknown>>;
  previewExtraction?: (input: { partId: string; modelId: string }) => Promise<Record<string, unknown>>;
};

const EVENT_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 4) {
    return "[max-depth]";
  }

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => toJsonValue(entry, depth + 1));
  }

  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {};

    Object.entries(value)
      .slice(0, 25)
      .forEach(([key, entry]) => {
        output[key] = toJsonValue(entry, depth + 1);
      });

    return output;
  }

  return String(value);
}

function normalizeRuntimeError(error: unknown): WorkerRuntimeError | null {
  if (error === null || error === undefined) {
    return null;
  }

  if (error instanceof Error) {
    const maybeError = error as Error & {
      code?: unknown;
      details?: unknown;
      hint?: unknown;
    };

    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      code: typeof maybeError.code === "string" ? maybeError.code : null,
      details:
        typeof maybeError.details === "string"
          ? maybeError.details
          : maybeError.details !== undefined
            ? JSON.stringify(toJsonValue(maybeError.details))
            : null,
      hint: typeof maybeError.hint === "string" ? maybeError.hint : null,
    };
  }

  if (isRecord(error)) {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      message:
        typeof error.message === "string"
          ? error.message
          : JSON.stringify(toJsonValue(error)),
      stack: typeof error.stack === "string" ? error.stack : null,
      code: typeof error.code === "string" ? error.code : null,
      details:
        typeof error.details === "string"
          ? error.details
          : error.details !== undefined
            ? JSON.stringify(toJsonValue(error.details))
            : null,
      hint: typeof error.hint === "string" ? error.hint : null,
    };
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
    code: null,
    details: null,
    hint: null,
  };
}

function deriveEventCounts(events: WorkerRuntimeEvent[]) {
  return events.reduce<Record<RuntimeEventLevel, number>>(
    (counts, event) => {
      counts[event.level] += 1;
      return counts;
    },
    { info: 0, warn: 0, error: 0 },
  );
}

export function createWorkerRuntimeState(): WorkerRuntimeState {
  return {
    startedAt: new Date().toISOString(),
    status: "starting",
    readinessIssues: [],
    lastLoopAt: null,
    lastTaskStartedAt: null,
    lastTaskCompletedAt: null,
    lastTaskFailedAt: null,
    currentTask: null,
    lastCompletedTask: null,
    lastFailedTask: null,
    lastError: null,
    lastErrorEvent: null,
    recentEvents: [],
    eventCounts: { info: 0, warn: 0, error: 0 },
  };
}

export function recordRuntimeEvent(
  state: WorkerRuntimeState,
  input: {
    level: RuntimeEventLevel;
    source: string;
    message: string;
    context?: Record<string, unknown>;
    error?: unknown;
  },
) {
  const event: WorkerRuntimeEvent = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level: input.level,
    source: input.source,
    message: input.message,
    context: input.context ? (toJsonValue(input.context) as Record<string, JsonValue>) : null,
    error: normalizeRuntimeError(input.error),
  };

  state.recentEvents = [event, ...state.recentEvents].slice(0, EVENT_LIMIT);
  state.eventCounts = deriveEventCounts(state.recentEvents);

  if (event.level === "error") {
    state.lastErrorEvent = event;
  }

  return event;
}

function writeJson(
  response: http.ServerResponse<http.IncomingMessage>,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function getSnapshot(config: WorkerConfig, state: WorkerRuntimeState) {
  const ready = state.status === "running" && state.readinessIssues.length === 0;

  return {
    service: "overdrafter-cad-worker",
    workerName: config.workerName,
    workerBuildVersion: config.workerBuildVersion,
    workerMode: config.workerMode,
    drawingExtractionModel: config.drawingExtractionModel,
    drawingExtractionDebugAllowedModels: config.drawingExtractionDebugAllowedModels,
    drawingExtractionModelFallbackEnabled: config.drawingExtractionEnableModelFallback,
    status: state.status,
    ready,
    readinessIssues: state.readinessIssues,
    startedAt: state.startedAt,
    lastLoopAt: state.lastLoopAt,
    lastTaskStartedAt: state.lastTaskStartedAt,
    lastTaskCompletedAt: state.lastTaskCompletedAt,
    lastTaskFailedAt: state.lastTaskFailedAt,
    currentTask: state.currentTask,
    lastCompletedTask: state.lastCompletedTask,
    lastFailedTask: state.lastFailedTask,
    lastError: state.lastError,
    lastErrorEvent: state.lastErrorEvent,
    eventCounts: state.eventCounts,
    recentEvents: state.recentEvents.slice(0, 10),
  };
}

export async function startHealthServer(
  config: WorkerConfig,
  state: WorkerRuntimeState,
  handlers: WorkerDebugHandlers = {},
) {
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? "/";

    if (url === "/" || url === "/healthz") {
      writeJson(response, 200, getSnapshot(config, state));
      return;
    }

    if (url === "/readyz") {
      const statusCode = state.status === "running" && state.readinessIssues.length === 0 ? 200 : 503;
      writeJson(response, statusCode, getSnapshot(config, state));
      return;
    }

    if (url === "/debug/events") {
      writeJson(response, 200, {
        service: "overdrafter-cad-worker",
        workerName: config.workerName,
        workerMode: config.workerMode,
        eventCounts: state.eventCounts,
        events: state.recentEvents,
      });
      return;
    }

    if (url === "/debug/extraction/models" && request.method === "GET") {
      if (!handlers.getExtractionModels) {
        writeJson(response, 404, { error: "not_found", path: url });
        return;
      }

      try {
        writeJson(response, 200, await handlers.getExtractionModels());
      } catch (error) {
        writeJson(response, 500, {
          error: "debug_models_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url === "/debug/extraction/models/refresh" && request.method === "POST") {
      if (!handlers.refreshExtractionModels) {
        writeJson(response, 404, { error: "not_found", path: url });
        return;
      }

      try {
        writeJson(response, 202, await handlers.refreshExtractionModels());
      } catch (error) {
        writeJson(response, 500, {
          error: "debug_models_refresh_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (url === "/debug/extraction/preview" && request.method === "POST") {
      if (!handlers.previewExtraction) {
        writeJson(response, 404, { error: "not_found", path: url });
        return;
      }

      try {
        const body = await readJsonBody(request);
        const partId = typeof body.partId === "string" ? body.partId.trim() : "";
        const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";

        if (!partId || !modelId) {
          writeJson(response, 400, {
            error: "invalid_preview_request",
            message: "partId and modelId are required.",
          });
          return;
        }

        writeJson(response, 200, await handlers.previewExtraction({ partId, modelId }));
      } catch (error) {
        writeJson(response, 500, {
          error: "debug_preview_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    writeJson(response, 404, {
      error: "not_found",
      path: url,
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.httpPort, config.httpHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const host = address?.address ?? config.httpHost;
  const port = address?.port ?? config.httpPort;

  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}
