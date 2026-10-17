// Thrown out of ctx.checkpoint() once a cancel has been applied. Agents should let it
// propagate; the graph treats it as a clean stop, not an agent failure.
export class RunCancelledError extends Error {
  constructor(readonly runId: string) {
    super(`design-graph run cancelled: ${runId}`);
    this.name = "RunCancelledError";
  }
}
