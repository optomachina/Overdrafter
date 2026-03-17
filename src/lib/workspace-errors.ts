export class WorkspaceNotReadyError extends Error {
  readonly toastId: string;

  constructor(message: string, toastId = "upload-workspace-gate") {
    super(message);
    this.name = "WorkspaceNotReadyError";
    this.toastId = toastId;
  }
}
