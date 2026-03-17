import { useSyncExternalStore } from "react";
import { toast } from "sonner";

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticCategory =
  | "console"
  | "toast"
  | "render"
  | "window-error"
  | "unhandled-rejection"
  | "react-query"
  | "react-mutation"
  | "network"
  | "lifecycle"
  | "manual";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type DiagnosticContext = {
  environment: string;
  route: string | null;
  href: string | null;
  userId: string | null;
  userEmail: string | null;
  organizationId: string | null;
  membershipRole: string | null;
  sessionState: "anonymous" | "signed_in";
  online: boolean | null;
  viewport: string | null;
  userAgent: string | null;
  language: string | null;
};

export type DiagnosticNormalizedError = {
  name: string;
  message: string;
  stack: string | null;
  code: string | null;
  details: string | null;
  hint: string | null;
  status: number | null;
  statusText: string | null;
};

export type DiagnosticEvent = {
  id: string;
  timestamp: string;
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  source: string;
  message: string;
  handled: boolean;
  context: DiagnosticContext;
  error: DiagnosticNormalizedError | null;
  details: JsonValue | null;
};

type ArchivedDeleteDiagnosticsSummary = {
  failureCategory: string;
  failureSummary: string;
  likelyCause: string;
  recommendedChecks: string[];
  fallbackPath: string;
  functionName: string | null;
  httpStatus: number | null;
  hasResponseBody: boolean | null;
  partIds: string[];
  organizationId: string | null;
  userId: string | null;
  eventId: string;
  eventTimestamp: string;
};

export type DiagnosticsSnapshot = {
  sessionId: string;
  enabled: boolean;
  panelOpen: boolean;
  context: DiagnosticContext;
  events: DiagnosticEvent[];
  counts: Record<DiagnosticLevel, number>;
};

type DiagnosticsState = DiagnosticsSnapshot;

type DiagnosticEventInput = {
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  source: string;
  message: string;
  handled?: boolean;
  error?: unknown;
  details?: unknown;
};

type InstallCleanup = () => void;

const ENABLED_STORAGE_KEY = "overdrafter.diagnostics.enabled";
const EVENT_LIMIT = 75;

const defaultContext = (): DiagnosticContext => ({
  environment: import.meta.env.MODE,
  route: typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}${window.location.hash}` : null,
  href: typeof window !== "undefined" ? window.location.href : null,
  userId: null,
  userEmail: null,
  organizationId: null,
  membershipRole: null,
  sessionState: "anonymous",
  online: typeof navigator !== "undefined" ? navigator.onLine : null,
  viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : null,
  userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
  language: typeof navigator !== "undefined" ? navigator.language : null,
});

function safeReadBoolean(key: string): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const value = window.localStorage.getItem(key);

    if (value === "1") {
      return true;
    }

    if (value === "0") {
      return false;
    }
  } catch {
    // Ignore storage access failures in restricted contexts.
  }

  return null;
}

function createSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth > 4) {
    return "[max-depth]";
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

function normalizeError(error: unknown): DiagnosticNormalizedError | null {
  if (error === null || error === undefined) {
    return null;
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error,
      stack: null,
      code: null,
      details: null,
      hint: null,
      status: null,
      statusText: null,
    };
  }

  if (error instanceof Error) {
    const maybeError = error as Error & {
      code?: unknown;
      details?: unknown;
      hint?: unknown;
      status?: unknown;
      statusText?: unknown;
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
      status: typeof maybeError.status === "number" ? maybeError.status : null,
      statusText: typeof maybeError.statusText === "string" ? maybeError.statusText : null,
    };
  }

  if (isRecord(error)) {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      message:
        typeof error.message === "string"
          ? error.message
          : typeof error.error_description === "string"
            ? error.error_description
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
      status: typeof error.status === "number" ? error.status : null,
      statusText: typeof error.statusText === "string" ? error.statusText : null,
    };
  }

  return {
    name: "Error",
    message: String(error),
    stack: null,
    code: null,
    details: null,
    hint: null,
    status: null,
    statusText: null,
  };
}

function summarizeConsoleArgs(args: unknown[]) {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }

      const normalizedError = normalizeError(arg);
      if (normalizedError) {
        return normalizedError.message;
      }

      return JSON.stringify(toJsonValue(arg));
    })
    .filter(Boolean)
    .join(" ")
    .slice(0, 1000);
}

function getArchivedDeleteDiagnosticsSummary(
  event: DiagnosticEvent | null | undefined,
): ArchivedDeleteDiagnosticsSummary | null {
  if (!event || !isRecord(event.details) || !Array.isArray(event.details.args)) {
    return null;
  }

  const reportingHolder = event.details.args.find(
    (entry) => isRecord(entry) && isRecord(entry.reporting) && entry.reporting.operation === "archived_delete",
  );

  if (!isRecord(reportingHolder) || !isRecord(reportingHolder.reporting)) {
    return null;
  }

  const reporting = reportingHolder.reporting;
  const partIds =
    Array.isArray(reporting.partIds) && reporting.partIds.every((entry) => typeof entry === "string")
      ? reporting.partIds
      : [];
  const recommendedChecks = reporting.recommendedChecks;

  if (
    typeof reporting.failureCategory !== "string" ||
    typeof reporting.failureSummary !== "string" ||
    typeof reporting.likelyCause !== "string" ||
    !Array.isArray(recommendedChecks) ||
    !recommendedChecks.every((entry) => typeof entry === "string") ||
    typeof reporting.fallbackPath !== "string"
  ) {
    return null;
  }

  return {
    failureCategory: reporting.failureCategory,
    failureSummary: reporting.failureSummary,
    likelyCause: reporting.likelyCause,
    recommendedChecks,
    fallbackPath: reporting.fallbackPath,
    functionName: typeof reporting.functionName === "string" ? reporting.functionName : null,
    httpStatus: typeof reporting.httpStatus === "number" ? reporting.httpStatus : null,
    hasResponseBody: typeof reporting.hasResponseBody === "boolean" ? reporting.hasResponseBody : null,
    partIds,
    organizationId: typeof reporting.organizationId === "string" ? reporting.organizationId : null,
    userId: typeof reporting.userId === "string" ? reporting.userId : null,
    eventId: event.id,
    eventTimestamp: event.timestamp,
  };
}

function findLatestArchivedDeleteDiagnosticsSummary(): ArchivedDeleteDiagnosticsSummary | null {
  for (const event of diagnosticsState.events) {
    const summary = getArchivedDeleteDiagnosticsSummary(event);

    if (summary) {
      return summary;
    }
  }

  return null;
}

function isIgnoredConsoleError(args: unknown[]) {
  const summary = summarizeConsoleArgs(args).toLowerCase();

  return summary.includes("invalid refresh token") && summary.includes("refresh token not found");
}

function deriveCounts(events: DiagnosticEvent[]) {
  return events.reduce<Record<DiagnosticLevel, number>>(
    (counts, event) => {
      counts[event.level] += 1;
      return counts;
    },
    { info: 0, warn: 0, error: 0 },
  );
}

function createInitialState(): DiagnosticsState {
  return {
    sessionId: createSessionId(),
    enabled: safeReadBoolean(ENABLED_STORAGE_KEY) ?? import.meta.env.DEV,
    panelOpen: false,
    context: defaultContext(),
    events: [],
    counts: { info: 0, warn: 0, error: 0 },
  };
}

let diagnosticsState = createInitialState();
const subscribers = new Set<() => void>();
let eventCounter = diagnosticsState.events.length;
let installCleanup: InstallCleanup | null = null;

function emit() {
  subscribers.forEach((listener) => listener());
}

function updateState(nextState: DiagnosticsState) {
  diagnosticsState = nextState;
  emit();
}

function appendEvent(input: DiagnosticEventInput) {
  eventCounter += 1;

  const event: DiagnosticEvent = {
    id: `${diagnosticsState.sessionId}-${eventCounter.toString(36)}`,
    timestamp: new Date().toISOString(),
    level: input.level,
    category: input.category,
    source: input.source,
    message: input.message,
    handled: input.handled ?? true,
    context: diagnosticsState.context,
    error: normalizeError(input.error),
    details: input.details === undefined ? null : toJsonValue(input.details),
  };

  const events = [event, ...diagnosticsState.events].slice(0, EVENT_LIMIT);
  updateState({
    ...diagnosticsState,
    events,
    counts: deriveCounts(events),
  });

  return event.id;
}

export function installDiagnostics() {
  if (installCleanup || typeof window === "undefined") {
    return;
  }

  const cleanupFns: InstallCleanup[] = [];

  const handleWindowError = (event: ErrorEvent) => {
    captureDiagnosticError(event.error ?? event.message, {
      category: "window-error",
      source: "window.error",
      handled: false,
      details: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      },
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    captureDiagnosticError(event.reason, {
      category: "unhandled-rejection",
      source: "window.unhandledrejection",
      handled: false,
    });
  };

  const handleConnectivityChange = () => {
    updateDiagnosticsContext({
      online: navigator.onLine,
    });

    appendEvent({
      level: navigator.onLine ? "info" : "warn",
      category: "network",
      source: navigator.onLine ? "window.online" : "window.offline",
      message: navigator.onLine ? "Browser connectivity restored." : "Browser connectivity lost.",
      handled: true,
    });
  };

  const handleResize = () => {
    updateDiagnosticsContext({
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  };

  window.addEventListener("error", handleWindowError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  window.addEventListener("online", handleConnectivityChange);
  window.addEventListener("offline", handleConnectivityChange);
  window.addEventListener("resize", handleResize);

  cleanupFns.push(() => window.removeEventListener("error", handleWindowError));
  cleanupFns.push(() => window.removeEventListener("unhandledrejection", handleUnhandledRejection));
  cleanupFns.push(() => window.removeEventListener("online", handleConnectivityChange));
  cleanupFns.push(() => window.removeEventListener("offline", handleConnectivityChange));
  cleanupFns.push(() => window.removeEventListener("resize", handleResize));

  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    if (!isIgnoredConsoleError(args)) {
      appendEvent({
        level: "error",
        category: "console",
        source: "console.error",
        message: summarizeConsoleArgs(args) || "console.error",
        handled: true,
        details: {
          args: args.map((arg) => toJsonValue(arg)),
        },
      });
    }

    originalConsoleError(...args);
  };

  console.warn = (...args: unknown[]) => {
    appendEvent({
      level: "warn",
      category: "console",
      source: "console.warn",
      message: summarizeConsoleArgs(args) || "console.warn",
      handled: true,
      details: {
        args: args.map((arg) => toJsonValue(arg)),
      },
    });

    originalConsoleWarn(...args);
  };

  cleanupFns.push(() => {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  const originalToastError = toast.error;
  const originalToastWarning = toast.warning;

  toast.error = ((message, ...args) => {
    appendEvent({
      level: "error",
      category: "toast",
      source: "toast.error",
      message: typeof message === "string" ? message : "Error toast emitted.",
      handled: true,
      details: {
        message: toJsonValue(message),
      },
    });

    return originalToastError(message, ...args);
  }) as typeof toast.error;

  toast.warning = ((message, ...args) => {
    appendEvent({
      level: "warn",
      category: "toast",
      source: "toast.warning",
      message: typeof message === "string" ? message : "Warning toast emitted.",
      handled: true,
      details: {
        message: toJsonValue(message),
      },
    });

    return originalToastWarning(message, ...args);
  }) as typeof toast.warning;

  cleanupFns.push(() => {
    toast.error = originalToastError;
    toast.warning = originalToastWarning;
  });

  window.__OVERDRAFTER_DEBUG__ = {
    clear: clearDiagnosticsEvents,
    exportJson: () => JSON.stringify(createDiagnosticsReport(), null, 2),
    getSnapshot: () => getDiagnosticsSnapshot(),
    open: () => {
      setDiagnosticsEnabled(true);
      setDiagnosticsPanelOpen(true);
    },
  };

  cleanupFns.push(() => {
    if (window.__OVERDRAFTER_DEBUG__) {
      delete window.__OVERDRAFTER_DEBUG__;
    }
  });

  appendEvent({
    level: "info",
    category: "lifecycle",
    source: "diagnostics.install",
    message: "Diagnostics listeners installed.",
    handled: true,
  });

  installCleanup = () => {
    cleanupFns.splice(0).forEach((cleanup) => cleanup());
    installCleanup = null;
  };
}

export function recordDiagnosticEvent(input: DiagnosticEventInput) {
  return appendEvent(input);
}

export function captureDiagnosticError(
  error: unknown,
  input: Omit<DiagnosticEventInput, "error" | "level" | "message"> & { message?: string },
) {
  const normalizedError = normalizeError(error);

  return appendEvent({
    ...input,
    level: "error",
    error,
    message: input.message ?? normalizedError?.message ?? "Unknown application error",
  });
}

export function updateDiagnosticsContext(context: Partial<DiagnosticContext>) {
  updateState({
    ...diagnosticsState,
    context: {
      ...diagnosticsState.context,
      ...context,
    },
  });
}

export function clearDiagnosticsEvents() {
  updateState({
    ...diagnosticsState,
    events: [],
    counts: { info: 0, warn: 0, error: 0 },
  });
}

export function setDiagnosticsEnabled(enabled: boolean) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Ignore local storage write failures.
    }
  }

  updateState({
    ...diagnosticsState,
    enabled,
  });
}

export function setDiagnosticsPanelOpen(panelOpen: boolean) {
  updateState({
    ...diagnosticsState,
    panelOpen,
  });
}

export function toggleDiagnosticsPanel() {
  setDiagnosticsEnabled(true);
  setDiagnosticsPanelOpen(!diagnosticsState.panelOpen);
}

export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return diagnosticsState;
}

export function useDiagnosticsSnapshot() {
  return useSyncExternalStore(
    (callback) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    getDiagnosticsSnapshot,
    getDiagnosticsSnapshot,
  );
}

export function createDiagnosticsReport() {
  const archivedDeleteDiagnostics = findLatestArchivedDeleteDiagnosticsSummary();

  return {
    generatedAt: new Date().toISOString(),
    sessionId: diagnosticsState.sessionId,
    context: diagnosticsState.context,
    counts: diagnosticsState.counts,
    events: diagnosticsState.events,
    archivedDeleteDiagnostics,
    browser:
      typeof window !== "undefined"
        ? {
            currentUrl: window.location.href,
            referrer: document.referrer,
            title: document.title,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
      }
        : null,
  };
}

function trimMultilineText(value: string, maxLines: number, maxChars: number) {
  const trimmedByChars = value.trim().slice(0, maxChars);
  const lines = trimmedByChars.split("\n").slice(0, maxLines);
  const joined = lines.join("\n");

  return value.trim().length > joined.length ? `${joined}\n...` : joined;
}

function formatContextForClipboard(context: DiagnosticContext) {
  return [
    `- Route: ${context.route ?? "unknown"}`,
    `- URL: ${context.href ?? "unknown"}`,
    `- Environment: ${context.environment}`,
    `- User: ${context.userEmail ?? "anonymous"}`,
    `- User ID: ${context.userId ?? "unknown"}`,
    `- Organization: ${context.organizationId ?? "unknown"}`,
    `- Role: ${context.membershipRole ?? "unknown"}`,
    `- Online: ${context.online === false ? "false" : "true"}`,
    `- Viewport: ${context.viewport ?? "unknown"}`,
  ].join("\n");
}

function formatEventForClipboard(event: DiagnosticEvent) {
  const lines = [
    `- Reference: ${event.id}`,
    `- Message: ${event.message}`,
    `- Source: ${event.source}`,
    `- Category: ${event.category}`,
    `- Level: ${event.level}`,
    `- Timestamp: ${event.timestamp}`,
    `- Handled: ${event.handled ? "true" : "false"}`,
  ];

  if (event.error) {
    lines.push(`- Error name: ${event.error.name}`);

    if (event.error.code) {
      lines.push(`- Error code: ${event.error.code}`);
    }

    if (event.error.hint) {
      lines.push(`- Error hint: ${event.error.hint}`);
    }

    if (event.error.details) {
      lines.push("", "Error details:", trimMultilineText(event.error.details, 8, 1000));
    }

    if (event.error.stack) {
      lines.push("", "Stack trace:", trimMultilineText(event.error.stack, 10, 1400));
    }
  }

  if (event.details) {
    lines.push("", "Event details:", trimMultilineText(JSON.stringify(event.details, null, 2), 10, 1200));
  }

  return lines.join("\n");
}

function formatArchivedDeleteDiagnosticsForClipboard(summary: ArchivedDeleteDiagnosticsSummary) {
  const lines = [
    "Archived Delete Diagnostics:",
    `- Failure category: ${summary.failureCategory}`,
    `- Summary: ${summary.failureSummary}`,
    `- Likely cause: ${summary.likelyCause}`,
    `- Fallback path: ${summary.fallbackPath}`,
    `- Function: ${summary.functionName ?? "unknown"}`,
  ];

  if (summary.httpStatus != null) {
    lines.push(`- HTTP status: ${summary.httpStatus}`);
  }

  if (summary.hasResponseBody != null) {
    lines.push(`- Response body present: ${summary.hasResponseBody ? "true" : "false"}`);
  }

  if (summary.partIds.length > 0) {
    lines.push(`- Affected part IDs: ${summary.partIds.join(", ")}`);
  }

  if (summary.organizationId) {
    lines.push(`- Organization: ${summary.organizationId}`);
  }

  if (summary.userId) {
    lines.push(`- User ID: ${summary.userId}`);
  }

  lines.push("- Recommended checks:");
  summary.recommendedChecks.forEach((entry) => {
    lines.push(`  - ${entry}`);
  });

  return lines.join("\n");
}

function formatRecentEventsForClipboard(limit = 3) {
  return diagnosticsState.events
    .slice(0, limit)
    .map((event, index) =>
      [
        `- ${index + 1}. [${event.level.toUpperCase()}] ${event.message}`,
        `  Ref: ${event.id}`,
        `  Source: ${event.source}`,
        event.error?.code ? `  Code: ${event.error.code}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

export function createDiagnosticClipboardText(input: {
  title: string;
  message?: string | null;
  event?: DiagnosticEvent | null;
  includeRecentEvents?: boolean;
}) {
  const relevantEvent =
    input.event ??
    diagnosticsState.events.find((event) => event.level === "error") ??
    diagnosticsState.events[0] ??
    null;
  const archivedDeleteDiagnostics =
    getArchivedDeleteDiagnosticsSummary(relevantEvent) ?? findLatestArchivedDeleteDiagnosticsSummary();
  const lines = [
    `Help debug this Overdrafter issue in Codex.`,
    "",
    `Title: ${input.title}`,
    `Generated: ${new Date().toISOString()}`,
    `Session: ${diagnosticsState.sessionId}`,
  ];

  if (input.message ?? relevantEvent?.message) {
    lines.push("", `Issue: ${input.message ?? relevantEvent?.message ?? "Unknown issue"}`);
  }

  if (archivedDeleteDiagnostics) {
    lines.push("", formatArchivedDeleteDiagnosticsForClipboard(archivedDeleteDiagnostics));
  }

  lines.push(
    "",
    "Context:",
    formatContextForClipboard(diagnosticsState.context),
  );

  if (input.message && input.message !== relevantEvent?.message) {
    lines.push("", `Popup message: ${input.message}`);
  }

  if (relevantEvent) {
    lines.push("", "Primary event:", formatEventForClipboard(relevantEvent));
  }

  if ((input.includeRecentEvents ?? true) && diagnosticsState.events.length > 0) {
    lines.push("", "Recent related events:", formatRecentEventsForClipboard());
  }

  return lines.join("\n");
}

export function createToastClipboardText(message: string) {
  const matchingEvent =
    diagnosticsState.events.find((event) => event.level === "error" && event.message === message) ??
    diagnosticsState.events.find((event) => event.level === "error") ??
    diagnosticsState.events[0] ??
    null;

  return createDiagnosticClipboardText({
    title: "Overdrafter error popup",
    message,
    event: matchingEvent,
  });
}

export async function copyTextToClipboard(text: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable.");
  }

  await navigator.clipboard.writeText(text);
}

export function resetDiagnosticsForTests() {
  if (installCleanup) {
    installCleanup();
  }

  diagnosticsState = createInitialState();
  eventCounter = 0;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(ENABLED_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
  }

  emit();
}

declare global {
  interface Window {
    __OVERDRAFTER_DEBUG__?: {
      clear: () => void;
      exportJson: () => string;
      getSnapshot: () => DiagnosticsSnapshot;
      open: () => void;
    };
  }
}
