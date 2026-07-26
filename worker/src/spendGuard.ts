import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Enforcement side of the spend cap.
 *
 * The cap is configured and observed in the admin surface, but it is enforced
 * here, at the point where money is actually spent. A ceiling checked only when
 * a user clicks something cannot stop a retry storm, a stuck loop, or any code
 * path that enqueues work directly — which is precisely the shape a runaway
 * takes.
 *
 * Budget is reserved before the spend and settled to the observed amount after.
 * Reserving first is what makes concurrent callers safe: a request that would
 * breach the ceiling is refused even while every other in-flight request is
 * still mid-call and has not yet reported a cost.
 */

export type SpendCategory = "llm_extraction" | "vendor_automation";

export type SpendContext = {
  jobId?: string | null;
  partId?: string | null;
  quoteRunId?: string | null;
  taskId?: string | null;
  provider?: string | null;
  modelName?: string | null;
};

export type SpendReservation = {
  reservationId: string;
  estimatedUsd: number;
};

export type SpendRefusal = {
  reasonCode: string;
  reason: string;
  dailyCeilingUsd?: number;
  dailySpendUsd?: number;
};

export class SpendCapExceededError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly category: SpendCategory,
  ) {
    super(message);
    this.name = "SpendCapExceededError";
  }
}

export interface SpendGuard {
  reserve(
    category: SpendCategory,
    estimatedUsd: number,
    context?: SpendContext,
  ): Promise<SpendReservation>;
  settle(reservation: SpendReservation, actualUsd: number | null): Promise<void>;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Supabase-backed guard.
 *
 * Fails closed. If the ledger cannot be reached the spend is refused rather than
 * allowed: an unreachable budget is exactly the condition under which an
 * unbounded spend path is least acceptable, and a guard that opens up when its
 * own storage is down provides no guarantee at all.
 */
export function createSpendGuard(
  supabase: SupabaseClient,
  organizationId: string | null,
): SpendGuard {
  return {
    async reserve(category, estimatedUsd, context = {}) {
      const { data, error } = await supabase.rpc("api_reserve_spend", {
        p_organization_id: organizationId,
        p_category: category,
        p_estimated_usd: estimatedUsd,
        p_context: {
          jobId: context.jobId ?? null,
          partId: context.partId ?? null,
          quoteRunId: context.quoteRunId ?? null,
          taskId: context.taskId ?? null,
          provider: context.provider ?? null,
          modelName: context.modelName ?? null,
        },
      });

      if (error) {
        throw new SpendCapExceededError(
          `Spend ledger unavailable, refusing to spend: ${error.message}`,
          "ledger_unavailable",
          category,
        );
      }

      const result = (data ?? {}) as Record<string, unknown>;

      if (!result.allowed) {
        const refusal = result as unknown as SpendRefusal;
        throw new SpendCapExceededError(
          refusal.reason ?? "Spend cap reached.",
          refusal.reasonCode ?? "spend_cap",
          category,
        );
      }

      return {
        reservationId: String(result.reservationId),
        estimatedUsd,
      };
    },

    async settle(reservation, actualUsd) {
      // A failed call still settles, at zero. Leaving the estimate in place
      // would hold budget for the rest of the window for spend that never
      // happened, which turns a transient provider error into a slow outage.
      const { error } = await supabase.rpc("api_settle_spend", {
        p_reservation_id: reservation.reservationId,
        p_actual_usd: Math.max(toNumber(actualUsd, 0), 0),
        p_metadata: {},
      });

      if (error) {
        // Settlement failure is not worth failing the surrounding work over:
        // the reservation already bounded the spend, and the estimate simply
        // stays booked until the window rolls.
        console.warn(
          JSON.stringify({
            service: "overdrafter-cad-worker",
            level: "warn",
            source: "spend.settle_failed",
            message: "Could not settle a spend reservation; its estimate stays booked.",
            context: { reservationId: reservation.reservationId, error: error.message },
          }),
        );
      }
    },
  };
}

/** A guard that permits everything. For tests and offline tooling only. */
export const permissiveSpendGuard: SpendGuard = {
  async reserve(_category, estimatedUsd) {
    return { reservationId: "permissive", estimatedUsd };
  },
  async settle() {
    /* no-op */
  },
};
