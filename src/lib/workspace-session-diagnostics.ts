import { getDiagnosticsSnapshot, recordDiagnosticEvent, type DiagnosticLevel } from "@/lib/diagnostics";

export function shouldRecordWorkspaceSessionDiagnostics(): boolean {
  return import.meta.env.DEV || getDiagnosticsSnapshot().enabled;
}

export function recordWorkspaceSessionDiagnostic(
  level: DiagnosticLevel,
  source: string,
  message: string,
  details?: unknown,
): void {
  if (!shouldRecordWorkspaceSessionDiagnostics()) {
    return;
  }

  recordDiagnosticEvent({
    level,
    category: "lifecycle",
    source,
    message,
    handled: true,
    details,
  });
}
