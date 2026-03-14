function getDiagnosticErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "";
}

export function shouldCaptureMutationDiagnostic(input: {
  error: unknown;
  meta?: Record<string, unknown> | undefined;
}) {
  const suppressedMessages = Array.isArray(input.meta?.suppressDiagnosticErrorMessages)
    ? input.meta.suppressDiagnosticErrorMessages.filter((value): value is string => typeof value === "string")
    : [];

  if (suppressedMessages.length === 0) {
    return true;
  }

  const errorMessage = getDiagnosticErrorMessage(input.error).toLowerCase();
  return !suppressedMessages.some((message) => errorMessage.includes(message.toLowerCase()));
}
