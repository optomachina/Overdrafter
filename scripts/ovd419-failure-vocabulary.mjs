// Canonical diagnostic vocabulary. Keep the sets private so callers cannot
// widen the allowed evidence by mutating an exported collection.

const PROMOTION_FAILURE_STAGES = new Set([
  "unknown",
  "observe_before_job",
  "evaluate_before_job",
  "replace_job",
  "observe_after_job",
  "verify_after_job",
  "observe_before_service",
  "evaluate_before_service",
  "replace_service",
  "observe_after_service",
  "verify_after_service",
  "verify_final_containment",
]);

const PROBE_FAILURE_STAGES = new Set([
  "unknown",
  "validate_request",
  "initial_inventory",
  "initial_containment",
  "baseline_snapshot",
  "pre_execution_inventory",
  "pre_execution_snapshot",
  "pre_execution_containment",
  "pre_execution_job_identity",
  "execute_probe",
  "validate_probe_result",
  "observe_execution_completion",
  "post_execution_snapshot",
  "verify_sequence_completion",
  "final_inventory",
  "final_containment",
]);

const PROBE_FAILURE_CODES = new Set([
  "probe_image_invalid",
  "probe_operations_missing",
  "probe_inventory_operation_failed",
  "probe_inventory_invalid",
  "probe_inventory_changed",
  "containment_operation_failed",
  "probe_preflight_failed",
  "snapshot_operation_failed",
  "snapshot_version_invalid",
  "snapshot_changed_before_probe",
  "probe_job_identity_invalid",
  "probe_job_observation_operation_failed",
  "probe_job_identity_changed",
  "probe_execution_operation_failed",
  "probe_execution_contract_failed",
  "probe_evidence_failed",
  "probe_inventory_completion_mismatch",
  "snapshot_changed_by_probe",
  "probe_final_containment_failed",
  "observation_snapshot_failed",
  "probe_sequence_failed",
]);

/** Accept only exact stages from the existing promotion failure contract. */
export function isPromotionFailureStage(value) {
  return PROMOTION_FAILURE_STAGES.has(value);
}

/** Accept only exact stages from the existing no-upload probe contract. */
export function isProbeFailureStage(value) {
  return PROBE_FAILURE_STAGES.has(value);
}

/** Accept only exact diagnostic codes; never coerce or retain unknown input. */
export function isProbeFailureCode(value) {
  return PROBE_FAILURE_CODES.has(value);
}
