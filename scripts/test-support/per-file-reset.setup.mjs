// Per-file state reset for `test.isolate: false`, used only when OVD_VITEST_ISOLATE=0
// opts into the shared-module-graph experiment (vite.config.ts); CI keeps isolation.
//
// With isolation off, the test files a worker runs share one module graph, one
// globalThis and one jsdom window, so state one file leaves behind can change
// the next file's result. This hook runs once per file: it snapshots the shared
// state before the file's tests and puts it back after them, then drops the
// module and mock caches so the next file imports fresh module instances (a
// module-level cache, singleton or vi.mock factory never crosses a file boundary). A file that needs more
// than this keeps its own afterEach/afterAll.
import { createRequire } from "node:module";
import { afterAll, beforeAll, vi } from "vitest";

const nodeRequire = createRequire(import.meta.url);

let envSnapshot;
let cwdSnapshot;
let exitCodeSnapshot;
let listenerSnapshot;

// Vitest 3.2 builds `vi` once per worker and keeps the first file's worker state,
// but a non-isolated fork gives every file a new one, so vi.setConfig in any later
// file (scripts/pre-push.test.mjs raises testTimeout this way) would change a
// stale config and silently keep the 5 s default. Point both calls at the
// current file's state; resetConfig still runs after each file.
const configBefore = new WeakMap();
vi.setConfig = (config) => {
  const state = currentWorkerState();
  if (!configBefore.has(state)) configBefore.set(state, { ...state.config });
  Object.assign(state.config, config);
};
vi.resetConfig = () => {
  const state = currentWorkerState();
  if (configBefore.has(state)) Object.assign(state.config, configBefore.get(state));
};

const PROCESS_EVENTS = ["unhandledRejection", "uncaughtException", "warning", "exit", "beforeExit"];

beforeAll(() => {
  envSnapshot = { ...process.env };
  cwdSnapshot = process.cwd();
  exitCodeSnapshot = process.exitCode;
  listenerSnapshot = new Map(PROCESS_EVENTS.map((event) => [event, new Set(process.listeners(event))]));
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  restoreProcessState();
  resetDocument();
  resetWindow();
  resetModuleGraph();
});

function restoreProcessState() {
  // Environment variables: drop added keys, restore changed and deleted ones.
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
  if (process.cwd() !== cwdSnapshot) process.chdir(cwdSnapshot);
  process.exitCode = exitCodeSnapshot;
  // Process listeners a file added and did not remove.
  for (const [event, before] of listenerSnapshot) {
    for (const listener of process.listeners(event)) {
      if (!before.has(listener)) process.removeListener(event, listener);
    }
  }
}

// jsdom: the window outlives the file, so clear what tests render or store.
function resetDocument() {
  if (typeof document === "undefined") return;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  for (const { name } of Array.from(document.documentElement.attributes)) {
    if (name !== "lang") document.documentElement.removeAttribute(name);
  }
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

function resetWindow() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.clear();
    window.sessionStorage?.clear();
  } catch {
    // Opaque-origin windows throw on storage access; nothing to clear.
  }
  if (!window.location?.href || window.location.href === "http://localhost:3000/") return;
  try {
    window.history.replaceState(null, "", "/");
  } catch {
    // Cross-origin URLs cannot be replaced; the next file sets its own.
  }
}

// What Vitest does between files when isolation is on (runBaseTests in vitest
// 3.2): clear the per-file mock registries and invalidate every evaluated
// module, mocked ones included. vi.resetModules() alone keeps the mocked
// modules, so a vi.mock factory from one file would leak into the next. These
// are worker internals, so fail loudly if a Vitest upgrade moves them rather
// than silently running files against each other's mocks.
function currentWorkerState() {
  const state = globalThis.__vitest_worker__;
  if (!state?.config) {
    throw new TypeError("per-file-reset: Vitest worker internals changed; update this hook or set test.isolate back to true");
  }
  return state;
}

function resetModuleGraph() {
  const mocker = globalThis.__vitest_mocker__;
  const moduleCache = currentWorkerState().moduleCache;
  if (typeof mocker?.reset !== "function" || typeof moduleCache?.invalidateModule !== "function") {
    throw new TypeError("per-file-reset: Vitest worker internals changed; update this hook or set test.isolate back to true");
  }
  mocker.reset();
  const keep = [/\/vitest\/dist\//, /\/vite-node\/dist\//, /vitest-virtual-\w+\/dist/, /@vitest\/dist/];
  moduleCache.forEach((mod, id) => {
    if (!keep.some((pattern) => pattern.test(id))) moduleCache.invalidateModule(mod);
  });
  // Testing Library's CommonJS files require each other through Node's own
  // cache, which outlives the module graph; drop them so `screen` and the
  // cleanup hooks bind to the next file's window (see server.deps.inline).
  for (const id of Object.keys(nodeRequire.cache)) {
    if (/[\\/]node_modules[\\/]@testing-library[\\/]/.test(id)) delete nodeRequire.cache[id];
  }
}
