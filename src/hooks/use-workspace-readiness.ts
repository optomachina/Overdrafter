import { useEffect, useRef } from "react";
import type { AppMembership } from "@/features/quotes/types";
import { WorkspaceNotReadyError } from "@/lib/workspace-errors";
import { deriveWorkspaceReadiness, type WorkspaceReadiness, type WorkspaceReadinessInput } from "./workspace-readiness";

const WAIT_TIMEOUT_MS = 30_000;

type Deferred = {
  resolve: (membership: AppMembership) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

/**
 * React hook that tracks workspace readiness and exposes a `waitForReady()` promise.
 * Callers can `await waitForReady()` instead of throwing immediately when membership
 * is not yet available (e.g. bootstrap is still in progress).
 */
export function useWorkspaceReadiness(input: WorkspaceReadinessInput) {
  const readiness = deriveWorkspaceReadiness(input);
  const deferredRef = useRef<Deferred | null>(null);
  const prevStatusRef = useRef<WorkspaceReadiness["status"] | null>(null);

  useEffect(() => {
    const prev = prevStatusRef.current;
    const current = readiness.status;

    if (import.meta.env.DEV && prev !== null && prev !== current) {
      console.warn("workspace-readiness: state transition", { from: prev, to: current });
    }

    prevStatusRef.current = current;

    if (!deferredRef.current) {
      return;
    }

    if (current === "ready") {
      const { resolve, timeoutId } = deferredRef.current;
      clearTimeout(timeoutId);
      deferredRef.current = null;
      resolve((readiness as Extract<typeof readiness, { status: "ready" }>).membership);
      return;
    }

    if (current === "anonymous") {
      const { reject, timeoutId } = deferredRef.current;
      clearTimeout(timeoutId);
      deferredRef.current = null;
      reject(new WorkspaceNotReadyError("Please sign in to continue."));
      return;
    }

    if (current === "unverified") {
      const { reject, timeoutId } = deferredRef.current;
      clearTimeout(timeoutId);
      deferredRef.current = null;
      reject(new WorkspaceNotReadyError("Please verify your email before uploading."));
      return;
    }

    if (current === "provisioning_failed") {
      const { reject, timeoutId } = deferredRef.current;
      clearTimeout(timeoutId);
      deferredRef.current = null;
      const message =
        (readiness as Extract<typeof readiness, { status: "provisioning_failed" }>).error;
      console.warn("workspace-readiness: bootstrap failed", { error: message });
      reject(new WorkspaceNotReadyError(message));
      return;
    }
  }, [readiness]);

  // Reject pending deferred on unmount
  useEffect(() => {
    return () => {
      if (deferredRef.current) {
        const { reject, timeoutId } = deferredRef.current;
        clearTimeout(timeoutId);
        deferredRef.current = null;
        reject(new WorkspaceNotReadyError("Component unmounted before workspace was ready."));
      }
    };
  }, []);

  /**
   * Returns a promise that resolves with the active membership once the workspace is ready.
   * If already ready, resolves immediately. Rejects after 30 seconds or on terminal states.
   */
  const waitForReady = (): Promise<AppMembership> => {
    if (readiness.status === "ready") {
      return Promise.resolve(readiness.membership);
    }

    if (readiness.status === "anonymous") {
      return Promise.reject(new WorkspaceNotReadyError("Please sign in to continue."));
    }

    if (readiness.status === "unverified") {
      return Promise.reject(new WorkspaceNotReadyError("Please verify your email before uploading."));
    }

    if (readiness.status === "provisioning_failed") {
      return Promise.reject(new WorkspaceNotReadyError(readiness.error));
    }

    // loading or provisioning — create or reuse a deferred promise
    if (deferredRef.current) {
      return new Promise<AppMembership>((resolve, reject) => {
        const existing = deferredRef.current;
        if (!existing) {
          resolve(undefined as unknown as AppMembership); // unreachable
          return;
        }
        const origResolve = existing.resolve;
        const origReject = existing.reject;
        existing.resolve = (m) => { origResolve(m); resolve(m); };
        existing.reject = (e) => { origReject(e); reject(e); };
      });
    }

    return new Promise<AppMembership>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const deferred = deferredRef.current;
        deferredRef.current = null;
        console.warn("workspace-readiness: wait timed out after 30s");
        const error = new WorkspaceNotReadyError("Your workspace is taking longer than expected. Please refresh and try again.");
        if (deferred) {
          deferred.reject(error);
        } else {
          reject(error);
        }
      }, WAIT_TIMEOUT_MS);

      deferredRef.current = { resolve, reject, timeoutId };
    });
  };

  return { readiness, waitForReady };
}
