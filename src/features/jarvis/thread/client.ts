export interface ThreadClient {
  resolve(runId: string, decisionId: string, answer: { resolution: 'chosen' | 'skipped_best_guess'; choice?: string; idempotencyKey: string }): Promise<{ status: number }>;
  /** Shell bridges to DesignGraph.control with the server derived actor. */
  control(runId: string, command: { kind: 'pause' | 'cancel'; idempotencyKey: string }): Promise<{ status: number }>;
}
