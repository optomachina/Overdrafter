#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

SERVICE_NAME="${SERVICE_NAME:-overdrafter-cad-worker}"
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-}"
REGION="${CLOUD_RUN_REGION:-us-west1}"
SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_SERVICE_ROLE_SECRET_NAME="${SUPABASE_SERVICE_ROLE_SECRET_NAME:-supabase-service-role-key}"
XOMETRY_STORAGE_STATE_SECRET_NAME="${XOMETRY_STORAGE_STATE_SECRET_NAME:-xometry-storage-state}"
XOMETRY_PROFILE_SNAPSHOT_BUCKET="${XOMETRY_PROFILE_SNAPSHOT_BUCKET:-}"
XOMETRY_PROFILE_SNAPSHOT_OBJECT="${XOMETRY_PROFILE_SNAPSHOT_OBJECT:-}"
XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES="${XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES:-268435456}"
OPENAI_API_KEY_SECRET_NAME="${OPENAI_API_KEY_SECRET_NAME:-}"
ANTHROPIC_API_KEY_SECRET_NAME="${ANTHROPIC_API_KEY_SECRET_NAME:-}"
WORKER_MODE="${WORKER_MODE:-live}"
WORKER_LIVE_ADAPTERS="${WORKER_LIVE_ADAPTERS:-xometry}"
WORKER_POLL_INTERVAL_MS="${WORKER_POLL_INTERVAL_MS:-5000}"
if [[ -z "${WORKER_BUILD_VERSION:-}" ]]; then
  WORKER_BUILD_VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if [[ "$WORKER_BUILD_VERSION" != "unknown" ]] && [[ -n "$(git status --porcelain --untracked-files=normal -- . 2>/dev/null)" ]]; then
    WORKER_BUILD_VERSION="${WORKER_BUILD_VERSION}-dirty"
  fi
fi
QUOTE_ARTIFACT_BUCKET="${QUOTE_ARTIFACT_BUCKET:-quote-artifacts}"
PLAYWRIGHT_HEADLESS="${PLAYWRIGHT_HEADLESS:-true}"
PLAYWRIGHT_CAPTURE_TRACE="${PLAYWRIGHT_CAPTURE_TRACE:-false}"
PLAYWRIGHT_BROWSER_TIMEOUT_MS="${PLAYWRIGHT_BROWSER_TIMEOUT_MS:-45000}"
PLAYWRIGHT_DISABLE_SANDBOX="${PLAYWRIGHT_DISABLE_SANDBOX:-true}"
PLAYWRIGHT_DISABLE_DEV_SHM_USAGE="${PLAYWRIGHT_DISABLE_DEV_SHM_USAGE:-true}"
XOMETRY_BROWSER_ENGINE="${XOMETRY_BROWSER_ENGINE:-playwright}"
CLOUD_RUN_SERVICE_ACCOUNT="${CLOUD_RUN_SERVICE_ACCOUNT:-}"
CLOUD_RUN_MIN_INSTANCES="${CLOUD_RUN_MIN_INSTANCES:-1}"
CLOUD_RUN_MAX_INSTANCES="${CLOUD_RUN_MAX_INSTANCES:-1}"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"

report_sanitized_gcloud_failure() {
  local diagnostic
  diagnostic="$(LC_ALL=C tr '[:upper:]' '[:lower:]' < "$1")"

  case "$diagnostic" in
    *"permission denied"*|*"permission_denied"*|*"unauthenticated"*|*"authentication failed"*|*"credentials are invalid"*|*"invalid credentials"*|*"active account"*|*"auth login"*)
      echo "Cloud CLI failure category: authentication or authorization." >&2
      ;;
    *"quota exceeded"*|*"quota_exceeded"*|*"rate limit"*|*"rate_limit"*|*"resource_exhausted"*)
      echo "Cloud CLI failure category: quota or rate limit." >&2
      ;;
    *"deadline_exceeded"*|*"timed out"*|*"network error"*|*"network failure"*|*"network timeout"*|*"network unreachable"*|*"connection error"*|*"connection failed"*|*"connection refused"*|*"connection reset"*|*"dns error"*|*"dns failure"*|*"service unavailable"*|*"temporarily unavailable"*)
      echo "Cloud CLI failure category: network or service availability." >&2
      ;;
    *"not found"*|*"not_found"*|*"does not exist"*|*"invalid argument"*|*"invalid_argument"*|*"failed_precondition"*|*"unknown project"*)
      echo "Cloud CLI failure category: resource or configuration." >&2
      ;;
    *)
      echo "Cloud CLI failure category: unclassified." >&2
      ;;
  esac
}

if [[ -z "$PROJECT_ID" ]]; then
  echo "GOOGLE_CLOUD_PROJECT is required."
  exit 1
fi

if [[ -z "$SUPABASE_URL" ]]; then
  echo "SUPABASE_URL is required."
  exit 1
fi

if ! [[ "$CLOUD_RUN_MIN_INSTANCES" =~ ^[0-9]+$ && "$CLOUD_RUN_MAX_INSTANCES" =~ ^[0-9]+$ ]]; then
  echo "CLOUD_RUN_MIN_INSTANCES and CLOUD_RUN_MAX_INSTANCES must be non-negative integers."
  exit 1
fi

if (( 10#$CLOUD_RUN_MAX_INSTANCES < 1 )); then
  echo "CLOUD_RUN_MAX_INSTANCES must be at least 1."
  exit 1
fi

if (( 10#$CLOUD_RUN_MIN_INSTANCES > 10#$CLOUD_RUN_MAX_INSTANCES )); then
  echo "CLOUD_RUN_MIN_INSTANCES cannot exceed CLOUD_RUN_MAX_INSTANCES."
  exit 1
fi

if { [[ -n "$XOMETRY_PROFILE_SNAPSHOT_BUCKET" ]] && [[ -z "$XOMETRY_PROFILE_SNAPSHOT_OBJECT" ]]; } ||
  { [[ -z "$XOMETRY_PROFILE_SNAPSHOT_BUCKET" ]] && [[ -n "$XOMETRY_PROFILE_SNAPSHOT_OBJECT" ]]; }; then
  echo "XOMETRY_PROFILE_SNAPSHOT_BUCKET and XOMETRY_PROFILE_SNAPSHOT_OBJECT must be configured together."
  exit 1
fi

SNAPSHOT_BUCKET_PREFLIGHT_SCRIPT="$SCRIPT_DIR/../scripts/verify-snapshot-bucket-controls.mjs"
if [[ -n "$XOMETRY_PROFILE_SNAPSHOT_BUCKET" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to run the snapshot bucket control preflight."
    exit 1
  fi
  if ! [[ -f "$SNAPSHOT_BUCKET_PREFLIGHT_SCRIPT" ]]; then
    echo "Snapshot bucket control preflight script is missing: $SNAPSHOT_BUCKET_PREFLIGHT_SCRIPT"
    exit 1
  fi

  GCLOUD_PREFLIGHT_STDERR_FILE="$(mktemp "${TMPDIR:-/tmp}/overdrafter-gcloud-preflight.XXXXXX")"
  cleanup_gcloud_preflight_stderr() {
    rm -f "$GCLOUD_PREFLIGHT_STDERR_FILE"
  }
  trap cleanup_gcloud_preflight_stderr EXIT

  if ! TARGET_PROJECT_NUMBER="$("$GCLOUD_BIN" projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>"$GCLOUD_PREFLIGHT_STDERR_FILE")"; then
    report_sanitized_gcloud_failure "$GCLOUD_PREFLIGHT_STDERR_FILE"
    echo "Target project number could not be resolved; refusing to deploy snapshot mode." >&2
    exit 1
  fi
  if ! [[ "$TARGET_PROJECT_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
    echo "Target project number is invalid; refusing to deploy snapshot mode." >&2
    exit 1
  fi

  echo "Verifying snapshot bucket ownership and controls (public access prevention, uniform bucket-level access, versioning, lifecycle)..."
  : > "$GCLOUD_PREFLIGHT_STDERR_FILE"
  if "$GCLOUD_BIN" storage buckets describe "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET" \
      --project "$PROJECT_ID" \
      --format='json(project_number,public_access_prevention,uniform_bucket_level_access,versioning_enabled,lifecycle_config)' \
      2>"$GCLOUD_PREFLIGHT_STDERR_FILE" \
      | node "$SNAPSHOT_BUCKET_PREFLIGHT_SCRIPT" --expected-project-number "$TARGET_PROJECT_NUMBER"; then
    :
  else
    PREFLIGHT_PIPELINE_STATUSES=("${PIPESTATUS[@]}")
    if (( PREFLIGHT_PIPELINE_STATUSES[0] != 0 )); then
      report_sanitized_gcloud_failure "$GCLOUD_PREFLIGHT_STDERR_FILE"
    fi
    echo "Snapshot bucket control preflight failed; refusing to deploy snapshot mode." >&2
    exit 1
  fi

  cleanup_gcloud_preflight_stderr
  trap - EXIT
fi

env_vars=(
  "SUPABASE_URL=${SUPABASE_URL}"
  "WORKER_MODE=${WORKER_MODE}"
  "WORKER_LIVE_ADAPTERS=${WORKER_LIVE_ADAPTERS}"
  "WORKER_NAME=${SERVICE_NAME}"
  "WORKER_POLL_INTERVAL_MS=${WORKER_POLL_INTERVAL_MS}"
  "WORKER_BUILD_VERSION=${WORKER_BUILD_VERSION}"
  "WORKER_HTTP_HOST=0.0.0.0"
  "WORKER_TEMP_DIR=/tmp/overdrafter-worker"
  "QUOTE_ARTIFACT_BUCKET=${QUOTE_ARTIFACT_BUCKET}"
  "PLAYWRIGHT_HEADLESS=${PLAYWRIGHT_HEADLESS}"
  "PLAYWRIGHT_CAPTURE_TRACE=${PLAYWRIGHT_CAPTURE_TRACE}"
  "PLAYWRIGHT_BROWSER_TIMEOUT_MS=${PLAYWRIGHT_BROWSER_TIMEOUT_MS}"
  "PLAYWRIGHT_DISABLE_SANDBOX=${PLAYWRIGHT_DISABLE_SANDBOX}"
  "PLAYWRIGHT_DISABLE_DEV_SHM_USAGE=${PLAYWRIGHT_DISABLE_DEV_SHM_USAGE}"
  "XOMETRY_BROWSER_ENGINE=${XOMETRY_BROWSER_ENGINE}"
)

secret_vars=(
  "SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_SECRET_NAME}:latest"
)
remove_secret_vars=()

if [[ -n "$XOMETRY_PROFILE_SNAPSHOT_BUCKET" ]]; then
  env_vars+=(
    "XOMETRY_PROFILE_SNAPSHOT_BUCKET=${XOMETRY_PROFILE_SNAPSHOT_BUCKET}"
    "XOMETRY_PROFILE_SNAPSHOT_OBJECT=${XOMETRY_PROFILE_SNAPSHOT_OBJECT}"
    "XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES=${XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES}"
  )
  remove_secret_vars+=("XOMETRY_STORAGE_STATE_JSON")
else
  secret_vars+=("XOMETRY_STORAGE_STATE_JSON=${XOMETRY_STORAGE_STATE_SECRET_NAME}:latest")
fi

if [[ -n "$OPENAI_API_KEY_SECRET_NAME" ]]; then
  secret_vars+=("OPENAI_API_KEY=${OPENAI_API_KEY_SECRET_NAME}:latest")
else
  remove_secret_vars+=("OPENAI_API_KEY")
fi

if [[ -n "$ANTHROPIC_API_KEY_SECRET_NAME" ]]; then
  secret_vars+=("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY_SECRET_NAME}:latest")
else
  remove_secret_vars+=("ANTHROPIC_API_KEY")
fi

# Customer drawing extraction must never inherit a previously configured
# OpenRouter credential from the Cloud Run service.
remove_secret_vars+=("OPENROUTER_API_KEY")

deploy_cmd=(
  "$GCLOUD_BIN" run deploy "$SERVICE_NAME"
  --project "$PROJECT_ID"
  --region "$REGION"
  --source .
  --execution-environment gen2
  --min-instances "$CLOUD_RUN_MIN_INSTANCES"
  --max-instances "$CLOUD_RUN_MAX_INSTANCES"
  --concurrency 1
  --cpu 2
  --memory 2Gi
  --timeout 3600
  --no-cpu-throttling
  --no-allow-unauthenticated
  --set-env-vars "$(IFS=,; echo "${env_vars[*]}")"
  --update-secrets "$(IFS=,; echo "${secret_vars[*]}")"
)

if [[ -n "$CLOUD_RUN_SERVICE_ACCOUNT" ]]; then
  deploy_cmd+=(--service-account "$CLOUD_RUN_SERVICE_ACCOUNT")
fi

if (( ${#remove_secret_vars[@]} > 0 )); then
  deploy_cmd+=(--remove-secrets "$(IFS=,; echo "${remove_secret_vars[*]}")")
fi

printf 'Deploying %s to project %s in %s\n' "$SERVICE_NAME" "$PROJECT_ID" "$REGION"
"${deploy_cmd[@]}"
