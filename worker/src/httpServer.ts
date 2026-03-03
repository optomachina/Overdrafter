import http from "node:http";
import type { AddressInfo } from "node:net";
import type { QueueTaskType, WorkerConfig } from "./types.js";

type RuntimeStatus = "starting" | "running" | "shutting_down";

type TaskSummary = {
  id: string;
  type: QueueTaskType;
};

export type WorkerRuntimeState = {
  startedAt: string;
  status: RuntimeStatus;
  lastLoopAt: string | null;
  lastTaskStartedAt: string | null;
  lastTaskCompletedAt: string | null;
  lastTaskFailedAt: string | null;
  currentTask: TaskSummary | null;
  lastCompletedTask: TaskSummary | null;
  lastFailedTask: TaskSummary | null;
  lastError: string | null;
};

export function createWorkerRuntimeState(): WorkerRuntimeState {
  return {
    startedAt: new Date().toISOString(),
    status: "starting",
    lastLoopAt: null,
    lastTaskStartedAt: null,
    lastTaskCompletedAt: null,
    lastTaskFailedAt: null,
    currentTask: null,
    lastCompletedTask: null,
    lastFailedTask: null,
    lastError: null,
  };
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

function getSnapshot(config: WorkerConfig, state: WorkerRuntimeState) {
  return {
    service: "overdrafter-cad-worker",
    workerName: config.workerName,
    workerMode: config.workerMode,
    status: state.status,
    startedAt: state.startedAt,
    lastLoopAt: state.lastLoopAt,
    lastTaskStartedAt: state.lastTaskStartedAt,
    lastTaskCompletedAt: state.lastTaskCompletedAt,
    lastTaskFailedAt: state.lastTaskFailedAt,
    currentTask: state.currentTask,
    lastCompletedTask: state.lastCompletedTask,
    lastFailedTask: state.lastFailedTask,
    lastError: state.lastError,
  };
}

export async function startHealthServer(
  config: WorkerConfig,
  state: WorkerRuntimeState,
) {
  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";

    if (url === "/" || url === "/healthz") {
      writeJson(response, 200, getSnapshot(config, state));
      return;
    }

    if (url === "/readyz") {
      const statusCode = state.status === "running" ? 200 : 503;
      writeJson(response, statusCode, getSnapshot(config, state));
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
