#!/usr/bin/env bash
# land_strict_merge.sh <pr-number>
#
# Lands one OverDrafter PR under strict branch protection (OVD-889). Run it from
# inside the repo checkout. It never merges unless one pinned head SHA is OPEN,
# contains the current base, has the protection-required checks successful on
# that exact SHA, and is still the PR head right before the merge. If this run
# had to update the branch, it merges only when that update left the reviewable
# diff unchanged. A changed diff stops the run; re-run land when checks pass.
#
#   1. Read the PR once and pin its head SHA.
#   2. If the head does not contain a freshly fetched origin/<base>, update it
#      with the REST update-branch API. Git decides: GitHub's BEHIND can be
#      stale right after an update, so it only triggers a re-check. That API
#      always MERGES the base into the head (it has no rebase mode) and takes
#      expected_head_sha, so GitHub refuses if the head moved. Never a rebase,
#      never a force push.
#   3. Wait for the new head and prove it is exactly that update merge (two
#      parents: the old pin, then a commit already on the base). Compare the
#      reviewable diff (diff_id, the sha256 of the pinned `git diff --raw`)
#      before and after. If it changed, stop with exit 10 and do not merge;
#      re-run land when checks pass. If it is unchanged, re-pin.
#   4. Read required checks from protection before updates; fail closed. Wait
#      for latest runs (and statuses for app-less contexts); only success passes.
#   5. Re-read state, head and mergeability, then
#      `gh pr merge --squash --match-head-commit <pin>`.
#   6. Report success only after GitHub shows MERGED with headRefOid == pin and
#      a valid merge commit whose fetched tree equals the pin. Log every update
#      round and the update chain. All calls and polls share an overall deadline.
#      A failed merge command is verified against the
#      same pin; the head is never re-read and re-pinned after a merge attempt.
#
# Fails closed: any unreadable, unknown, mismatched or timed-out state stops
# with `land: STOP: ...` on stderr.
#
# Exit codes (SKILL.md step 9 routes on these):
#   0  merged and verified
#   2  usage or precondition (bad PR number, missing tool, not OPEN, draft,
#      wrong base, not in a git work tree, bad configuration)
#   3  a required check failed on the pinned head            -> Rework
#   4  bounded wait timed out (head, checks, mergeability, merge confirmation)
#   5  head changed, malformed SHA, unexpected history, unknown state, merge
#      refused or not verified                                -> Human Review
#   6  merge conflict (DIRTY, or update-branch refused for a conflict) -> Rework
#   7  update round cap exceeded because the base kept moving
#   8  overall deadline exceeded; if merge sent, inspect PR by hand
#   9  merged but post-merge read-back failed or exceeded deadline -> Human Review; never auto-revert
#   10 updated branch, but the diff changed; re-run land when checks pass
#
# Settings (non-negative integers unless noted; defaults in brackets):
#   LAND_POLL_INTERVAL [15] seconds between polls   LAND_HEAD_POLLS [24]
#   LAND_CHECK_POLLS [80]   LAND_MERGEABLE_POLLS [20]   LAND_MERGE_POLLS [40]
#   LAND_MAX_UPDATES [3]    LAND_REQUIRED_APP_ID [15368, GitHub Actions, fallback only]
#   LAND_REQUIRED_CHECKS ["ci provider-go-live", fallback only]
#   LAND_BASE [main]; non-main requires an explicit LAND_BASE override
#   LAND_DEADLINE [3600, >=1] overall seconds; LAND_CALL_TIMEOUT [60, >=1]
#   LAND_ALLOW_FALLBACK_CHECKS [0]; 1 explicitly permits fallback if protection is unreadable
#   LAND_GH [gh]  LAND_SLEEP [sleep]  LAND_GH_TIMEOUT (legacy alias for LAND_CALL_TIMEOUT)
#
# Portable to bash 3.2 (macOS): no ${var,,}, no mapfile, no associative arrays.

set -u -o pipefail
# ASCII collation, so the [!0-9a-f] style patterns below mean exactly that.
export LC_ALL=C

MERGE_SENT=false
MERGED_SEEN=false
DEADLINE_AT=2147483647
stop() {
  local code="$1" reason="$2"
  if { [ "$code" = 4 ] || [ "$code" = 5 ]; } && [ "$SECONDS" -ge "$DEADLINE_AT" ]; then code=8; fi
  if [ "$code" = 8 ] && [ "$MERGED_SEEN" = true ]; then
    code=9
    reason='MERGED but the post-merge read-back did not finish before the overall deadline; do not mark Done, do NOT auto-revert, escalate to Human Review'
  fi
  if [ "$code" = 8 ]; then
    reason="$reason; overall deadline of ${LAND_DEADLINE} s exceeded"
    if [ "$MERGE_SENT" = true ]; then reason="$reason; merge command was sent; PR state must be checked by hand"; fi
  fi
  printf 'land: STOP: %s\n' "$reason" >&2; exit "$code"
}
note() { printf 'land: %s\n' "$1" >&2; }

# A full commit SHA: the WHOLE string is exactly 40 lowercase hex characters.
# No grep (which matches per line, so "<sha>\n<junk>" would pass).
is_sha() {
  local x="${1-}"
  [ "${#x}" -eq 40 ] || return 1
  case "$x" in *[!0-9a-f]*) return 1 ;; esac
  return 0
}

# DIFF_ID = sha256 of `git diff --raw -z` for base...head. The argv matches
# computeDiffId in scripts/emit-verdict.mjs, so this is the same reviewable
# diff OVD-845 uses for carry-over. --raw -z contains NUL bytes; the bytes are
# piped to the hasher and never stored in a shell variable. Returns 1 when the
# diff cannot be hashed. An empty diff hashes as the sha256 of empty input.
review_diff_id() {
  local base="$1" head="$2" raw
  is_sha "$base" && is_sha "$head" || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    raw="$(git diff --raw -z --no-abbrev --no-renames --full-index --no-relative --ignore-submodules=none -O/dev/null --no-color --end-of-options "${base}...${head}" -- | sha256sum)" || return 1
  elif command -v shasum >/dev/null 2>&1; then
    raw="$(git diff --raw -z --no-abbrev --no-renames --full-index --no-relative --ignore-submodules=none -O/dev/null --no-color --end-of-options "${base}...${head}" -- | shasum -a 256)" || return 1
  else
    return 1
  fi
  DIFF_ID="${raw%% *}"
  [ "${#DIFF_ID}" -eq 64 ] || return 1
  case "$DIFF_ID" in *[!0-9a-f]*) return 1 ;; esac
  return 0
}

deadline() { [ "$SECONDS" -lt "$DEADLINE_AT" ] || stop 8 'deadline reached'; }
# Isolate each command so cleanup also closes pipes held by its descendants.
bounded() {
  local budget="$1" command_pid watchdog_pid result
  shift
  set -m
  "$@" &
  command_pid=$!
  set +m
  (
    sleeper=''
    trap 'if [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null; wait "$sleeper" 2>/dev/null; fi; exit 0' TERM INT
    sleep "$budget" &
    sleeper=$!
    wait "$sleeper"
    kill -TERM -- -"$command_pid" 2>/dev/null || :
    sleep 2 &
    sleeper=$!
    wait "$sleeper"
    kill -KILL -- -"$command_pid" 2>/dev/null || :
  ) >/dev/null 2>&1 &
  watchdog_pid=$!
  result=0
  wait "$command_pid" || result=$?
  kill -KILL -- -"$command_pid" 2>/dev/null || :
  kill "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null || :
  return "$result"
}
call() {
  deadline
  local budget=$((DEADLINE_AT - SECONDS))
  if [ "$budget" -gt "$LAND_CALL_TIMEOUT" ]; then budget="$LAND_CALL_TIMEOUT"; fi
  bounded "$budget" "$@"
}
gh_cmd() { call "${LAND_GH:-gh}" "$@"; }
fetch_cmd() { call git fetch "$@"; }
pause() {
  deadline
  [ "$((SECONDS + LAND_POLL_INTERVAL))" -lt "$DEADLINE_AT" ] || stop 8 'poll would cross deadline'
  "${LAND_SLEEP:-sleep}" "$LAND_POLL_INTERVAL" || stop 5 'sleep failed'
}
progress() { printf 'land: poll %s/%s %s\n' "$1" "$2" "$3" >&2; }

# FIELD=<string value of a path in $JSON>, "" if absent or not a string.
# Two ways a malformed value could be "repaired" on its way into bash are
# closed here: NUL characters (bash drops them silently, so "\u0000<40 hex>"
# would become a valid SHA) are mapped to "!" inside jq, and the "." sentinel
# stops command substitution from stripping trailing newlines, so "<sha>\n"
# stays malformed.
field() {
  local value
  value="$(printf '%s' "$JSON" | jq -j "$1 | if type == \"string\" then (explode | map(if . == 0 then 33 else . end) | implode) else \"\" end" && printf '.')" \
    || stop 5 'unreadable JSON field'
  FIELD="${value%.}"
}

# One gh call for state, draft, mergeability, head and base. Returns 1 when gh
# fails or the output is not a JSON object (an unverified poll). Stops on a
# malformed SHA or an unrecognised enum value.
read_pr() {
  JSON="$(gh_cmd pr view "$PR" --json state,isDraft,mergeStateStatus,headRefOid,baseRefName 2>/dev/null)" || return 1
  printf '%s' "$JSON" | jq -e 'type == "object"' >/dev/null 2>&1 || return 1
  field '.headRefOid'; HEAD="$FIELD"
  is_sha "$HEAD" || stop 5 'malformed SHA in PR headRefOid'
  field '.state'; STATE="$FIELD"
  field '.mergeStateStatus'; MS="$FIELD"
  field '.baseRefName'; BASE="$FIELD"
  field '.isDraft | tostring'; DRAFT="$FIELD"
  case "$STATE" in OPEN|CLOSED|MERGED) ;; *) stop 5 "unknown PR state '$STATE'" ;; esac
  case "$MS" in CLEAN|HAS_HOOKS|UNSTABLE|BEHIND|BLOCKED|UNKNOWN|DIRTY|DRAFT) ;; *) stop 5 "unknown merge state '$MS'" ;; esac
  case "$DRAFT" in true|false) ;; *) stop 5 'unknown draft state' ;; esac
  return 0
}

# The PR must still be the one we pinned: OPEN, non-draft, same base, same head.
require_pinned_open() {
  [ "$STATE" = OPEN ] || stop 5 "PR is $STATE, expected OPEN"
  [ "$HEAD" = "$PIN" ] || stop 5 "head changed from $PIN to $HEAD"
  [ "$BASE" = "$LAND_BASE" ] || stop 5 'base branch changed'
  [ "$DRAFT" = false ] || stop 5 'PR became draft'
}

# BASE_TIP=<fresh origin/<base> SHA>.
fetch_base() {
  fetch_cmd --quiet --no-tags -- origin "+refs/heads/$LAND_BASE:refs/remotes/origin/$LAND_BASE" \
    || stop 5 'git fetch of the base failed'
  BASE_TIP="$(git rev-parse --verify --quiet "refs/remotes/origin/$LAND_BASE^{commit}")" \
    || stop 5 'base ref unreadable'
  is_sha "$BASE_TIP" || stop 5 'malformed base SHA'
}

# Only called with SHAs that passed is_sha.
fetch_sha() {
  fetch_cmd --quiet --no-tags -- origin "$1" || stop 5 "git fetch of $1 failed"
}

# BASE_IN_PIN=0 when the fresh base tip is an ancestor of (or equal to) PIN,
# 1 when it is not (the PR is behind). Any other git status stops.
base_in_pin() {
  fetch_base
  fetch_sha "$PIN"
  git merge-base --is-ancestor "$BASE_TIP" "$PIN"
  BASE_IN_PIN=$?
  case "$BASE_IN_PIN" in 0|1) ;; *) stop 5 'git ancestry check failed' ;; esac
}

# ---- arguments, tools, settings -------------------------------------------

[ "$#" -eq 1 ] || stop 2 'usage: land_strict_merge.sh <pr-number>'
case "$1" in ''|*[!0-9]*|0*) stop 2 'PR number must be a positive integer without leading zeros' ;; esac
[ "${#1}" -le 9 ] || stop 2 'PR number out of range'
PR="$1"

for tool in "${LAND_GH:-gh}" jq git; do
  command -v "$tool" >/dev/null 2>&1 || stop 2 "missing required tool: $tool"
done
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || stop 2 'not inside a git work tree'

LAND_POLL_INTERVAL="${LAND_POLL_INTERVAL-15}"
LAND_HEAD_POLLS="${LAND_HEAD_POLLS-24}"
LAND_CHECK_POLLS="${LAND_CHECK_POLLS-80}"
LAND_MERGEABLE_POLLS="${LAND_MERGEABLE_POLLS-20}"
LAND_MERGE_POLLS="${LAND_MERGE_POLLS-40}"
LAND_MAX_UPDATES="${LAND_MAX_UPDATES-3}"
LAND_REQUIRED_APP_ID="${LAND_REQUIRED_APP_ID-15368}"
LAND_REQUIRED_CHECKS="${LAND_REQUIRED_CHECKS-ci provider-go-live}"
LAND_BASE="${LAND_BASE:-main}"
LAND_DEADLINE="${LAND_DEADLINE-3600}"
LAND_CALL_TIMEOUT="${LAND_CALL_TIMEOUT-${LAND_GH_TIMEOUT-60}}"
LAND_ALLOW_FALLBACK_CHECKS="${LAND_ALLOW_FALLBACK_CHECKS-0}"
export GIT_HTTP_LOW_SPEED_LIMIT="${GIT_HTTP_LOW_SPEED_LIMIT-1000}"
export GIT_HTTP_LOW_SPEED_TIME="${GIT_HTTP_LOW_SPEED_TIME-30}"
case "$LAND_ALLOW_FALLBACK_CHECKS" in ''|0|1) ;; *) stop 2 'invalid LAND_ALLOW_FALLBACK_CHECKS' ;; esac

for setting in LAND_POLL_INTERVAL LAND_HEAD_POLLS LAND_CHECK_POLLS LAND_MERGEABLE_POLLS \
  LAND_MERGE_POLLS LAND_MAX_UPDATES LAND_REQUIRED_APP_ID LAND_DEADLINE LAND_CALL_TIMEOUT; do
  value="${!setting}"
  case "$value" in ''|*[!0-9]*) stop 2 "invalid numeric configuration: $setting" ;; esac
  # Strip leading zeros so bash arithmetic does not read the value as octal.
  while [ "${#value}" -gt 1 ] && [ "${value:0:1}" = 0 ]; do value="${value:1}"; done
  # Bound the width so arithmetic cannot overflow and disable a limit.
  [ "${#value}" -le 9 ] || stop 2 "numeric configuration out of range: $setting"
  printf -v "$setting" '%s' "$value"
done

case "$LAND_BASE" in -*|*[!A-Za-z0-9._/-]*) stop 2 'invalid base branch name' ;; esac
git check-ref-format "refs/heads/$LAND_BASE" >/dev/null 2>&1 || stop 2 'invalid base branch name'

[ "$LAND_DEADLINE" -ge 1 ] && [ "$LAND_CALL_TIMEOUT" -ge 1 ] || stop 2 'invalid numeric configuration: deadline/call budget must be positive'
DEADLINE_AT=$((SECONDS + LAND_DEADLINE))

# ---- 1. pin ----------------------------------------------------------------

read_pr || stop 5 'PR unreadable'
[ "$STATE" = OPEN ] || stop 2 "PR is $STATE, expected OPEN"
[ "$MS" != DRAFT ] || stop 2 'PR is draft; mark it ready first'
[ "$DRAFT" = false ] || stop 2 'PR is draft; mark it ready first'
[ "$BASE" = "$LAND_BASE" ] || stop 2 "PR base is '$BASE', expected '$LAND_BASE'"
PIN="$HEAD"
note "pinned head $PIN"

# Protection is authoritative; fallback requires an explicit opt-in.
protection="$(gh_cmd api "repos/{owner}/{repo}/branches/$LAND_BASE/protection/required_status_checks" 2>/dev/null)" || protection=''
deadline
required="$(printf '%s' "$protection" | jq -ce '
  def valid: type == "object" and (.context | type == "string" and test("^[A-Za-z0-9._][A-Za-z0-9._ -]*$") and (test("[^A-Za-z0-9._ -]") | not)) and
    (.app_id == null or (.app_id | type == "number" and . > 0 and floor == .));
  if type != "object" then error("object required") else
    (if has("checks") then .checks else [.contexts[] | {context: ., app_id: null}] end) |
    if type == "array" and length > 0 and all(.[]; valid) then . else error("invalid checks") end end
' 2>/dev/null)" || required=''
if [ -z "$required" ]; then
  [ "$LAND_ALLOW_FALLBACK_CHECKS" = 1 ] || stop 2 'required checks unreadable from branch protection (no valid checks)'
  note 'WARNING: required checks unreadable from branch protection; USING EXPLICIT FALLBACK CHECKS'
  required="$(jq -cn --arg names "$LAND_REQUIRED_CHECKS" --argjson app "$LAND_REQUIRED_APP_ID" '
    $names | split(" ") | map(select(length > 0)) |
    if length > 0 and all(.[]; test("^[A-Za-z0-9._][A-Za-z0-9._-]*$")) and $app > 0
    then map({context: ., app_id: $app}) else error("invalid fallback") end')" || stop 2 'invalid fallback required checks'
fi
checks=()
while IFS= read -r entry; do checks+=("$entry"); done < <(printf '%s' "$required" | jq -c '.[]')
note "required checks from protection: $(printf '%s' "$required" | jq -r 'map(.context + "(app " + (.app_id | tostring) + ")") | join(" ")')"
chain=''

round=0
while :; do
  deadline
  [ "$MS" != DIRTY ] || stop 6 'merge conflict (mergeStateStatus DIRTY)'

  # ---- 2-3. update a behind branch with a merge, then re-pin ----------------
  # Git decides "behind": GitHub's mergeStateStatus is computed lazily and can
  # read BEHIND or UNKNOWN for a while after an update.
  base_in_pin
  if [ "$BASE_IN_PIN" -eq 1 ]; then
    [ "$round" -lt "$LAND_MAX_UPDATES" ] || stop 7 "base kept moving; $LAND_MAX_UPDATES update rounds used"
    note "head $PIN does not contain origin/$LAND_BASE $BASE_TIP; updating with a merge"
    if ! output="$(gh_cmd api -X PUT "repos/{owner}/{repo}/pulls/$PR/update-branch" -f "expected_head_sha=$PIN" 2>&1)"; then
      lower="$(printf '%s' "$output" | tr '[:upper:]' '[:lower:]')"
      case "$lower" in
        *'merge conflict'*) stop 6 'update-branch refused: merge conflict' ;;
        *'expected head sha'*) stop 5 'update-branch refused: head moved since it was pinned' ;;
        *) stop 5 "update-branch failed: $output" ;;
      esac
    fi

    moved=false
    i=1
    while [ "$i" -le "$LAND_HEAD_POLLS" ]; do
      pause
      deadline
      progress "$i" "$LAND_HEAD_POLLS" 'waiting for the updated head'
      i=$((i + 1))
      read_pr || { deadline; continue; }
      [ "$STATE" = OPEN ] || stop 5 "PR is $STATE during the update"
      [ "$BASE" = "$LAND_BASE" ] && [ "$DRAFT" = false ] || stop 5 'PR base or draft state changed during the update'
      if [ "$HEAD" != "$PIN" ]; then moved=true; break; fi
    done
    [ "$moved" = true ] || stop 4 'timed out waiting for the updated head'
    NEW="$HEAD"

    # Prove NEW is exactly the update merge: two parents, the first is the old
    # pin, the second is already on the base. A rebase, force push or any other
    # push fails this.
    fetch_sha "$NEW"
    fetch_base
    parents="$(git rev-list --parents -n 1 "$NEW")" || stop 5 'history of the updated head unreadable'
    set -f
    # shellcheck disable=SC2086  # split "<new> <p1> <p2>" on spaces; globbing is off
    set -- $parents
    set +f
    [ "$#" -eq 3 ] || stop 5 "unexpected history: $NEW is not a two-parent update merge"
    for value in "$1" "$2" "$3"; do is_sha "$value" || stop 5 'malformed SHA in history'; done
    [ "$1" = "$NEW" ] || stop 5 'unexpected history: rev-list returned another commit'
    [ "$2" = "$PIN" ] || stop 5 "unexpected history: first parent of $NEW is $2, not the pinned $PIN"
    git merge-base --is-ancestor "$3" "$BASE_TIP" \
      || stop 5 "unexpected history: second parent $3 is not on origin/$LAND_BASE"

    # Same diff_id means the update did not change the reviewable diff, so the
    # head that was already reviewed can still be merged after checks pass on
    # the new SHA. A different diff_id needs a fresh review; do not merge it
    # in this run.
    old_base="$(git merge-base "$PIN" "$3")" || stop 5 'could not read the pre-update merge-base; not merging'
    is_sha "$old_base" || stop 5 'malformed pre-update merge-base; not merging'
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
      stop 5 'could not hash the diff (no sha256sum or shasum); not merging'
    fi
    review_diff_id "$old_base" "$PIN" || stop 5 'could not read the pre-update diff; not merging'
    old_diff="$DIFF_ID"
    review_diff_id "$3" "$NEW" || stop 5 'could not read the post-update diff; not merging'
    if [ "$old_diff" != "$DIFF_ID" ]; then
      note "update round $((round + 1))/$LAND_MAX_UPDATES: old head $PIN -> new head $NEW (origin/$LAND_BASE $BASE_TIP, second parent $3); diff changed"
      stop 10 "updated $PIN -> $NEW but the diff changed; re-run land when checks pass"
    fi

    note "update round $((round + 1))/$LAND_MAX_UPDATES: old head $PIN -> new head $NEW (origin/$LAND_BASE $BASE_TIP, second parent $3); diff unchanged"
    chain="${chain}${chain:+; }$PIN -> $NEW ($LAND_BASE $BASE_TIP)"
    PIN="$NEW"   # the only re-pin, and only after the history and diff checks above
    round=$((round + 1))
    note "updated branch; diff unchanged; new pinned head $PIN"
  fi

  # ---- 4. required checks on the pin -----------------------------------------
  passed=false
  i=1
  while [ "$i" -le "$LAND_CHECK_POLLS" ]; do
    [ "$i" -eq 1 ] || pause
    deadline
    progress "$i" "$LAND_CHECK_POLLS" "waiting for required checks on $PIN"
    i=$((i + 1))
    all=true
    for entry in "${checks[@]}"; do
      deadline
      name="$(printf '%s' "$entry" | jq -r '.context')"
      app="$(printf '%s' "$entry" | jq -r '.app_id')"
      encoded="$(printf '%s' "$entry" | jq -r '.context | @uri')"
      if ! JSON="$(gh_cmd api "repos/{owner}/{repo}/commits/$PIN/check-runs?check_name=$encoded&filter=latest&per_page=100" 2>/dev/null)"; then
        deadline; all=false; continue
      fi
      # Only runs from the required app, for this exact SHA and name, count.
      # None yet (not registered on a new head) is pending, never a failure.
      verdict="$(printf '%s' "$JSON" | jq -r --arg pin "$PIN" --arg name "$name" --argjson app "$app" '
        if type != "object" or (.check_runs | type) != "array" then "invalid" else
        [.check_runs[] | select(type == "object" and ($app == null or .app.id == $app) and .head_sha == $pin and .name == $name)] as $runs |
        ($runs | sort_by(.id // 0) | last) as $run |
        if $run == null then "absent" elif $run.status != "completed" then "pending"
        elif $run.conclusion == "success" then "pass" else "failed" end end' 2>/dev/null)" || verdict=invalid
      if [ "$app" = null ]; then
        status_verdict=invalid
        if statuses="$(gh_cmd api "repos/{owner}/{repo}/commits/$PIN/status?per_page=100" 2>/dev/null)"; then
          status_verdict="$(printf '%s' "$statuses" | jq -r --arg pin "$PIN" --arg name "$name" '
            if type != "object" or .sha != $pin or (.statuses | type) != "array"
              or (.total_count | type) != "number" or .total_count > (.statuses | length) then "invalid" else
            ([.statuses[] | select(.context == $name)] | sort_by(.id // 0) | last) as $s |
            if $s == null then "absent" elif $s.state == "success" then "pass"
            elif $s.state == "pending" then "pending" else "failed" end end' 2>/dev/null)" || status_verdict=invalid
        else deadline; fi
        if [ "$verdict" = failed ] || [ "$status_verdict" = failed ]; then verdict=failed
        elif [ "$status_verdict" = pass ] && { [ "$verdict" = pass ] || [ "$verdict" = absent ]; }; then verdict=pass
        elif [ "$verdict" = pass ] && [ "$status_verdict" = absent ]; then verdict=pass
        else verdict=pending; fi
      fi
      case "$verdict" in
        failed) stop 3 "required check $name FAILED on $PIN" ;;
        pass) ;;
        *) all=false ;;
      esac
    done
    if read_pr; then require_pinned_open; else deadline; all=false; fi
    if [ "$all" = true ]; then passed=true; break; fi
  done
  [ "$passed" = true ] || stop 4 "timed out waiting for required checks on $PIN"

  # ---- 5. re-verify right before the merge -----------------------------------
  ready=false
  behind=false
  i=1
  while [ "$i" -le "$LAND_MERGEABLE_POLLS" ]; do
    [ "$i" -eq 1 ] || pause
    deadline
    progress "$i" "$LAND_MERGEABLE_POLLS" 'waiting for mergeability'
    i=$((i + 1))
    read_pr || { deadline; continue; }
    require_pinned_open
    case "$MS" in
      CLEAN|HAS_HOOKS|UNSTABLE) ready=true; break ;;
      BEHIND)
        # Trust a fresh fetch: if the pin already contains the base, BEHIND is
        # GitHub catching up after the update, so keep waiting.
        base_in_pin
        if [ "$BASE_IN_PIN" -eq 1 ]; then behind=true; break; fi ;;
      BLOCKED|UNKNOWN) ;;
      DIRTY) stop 6 'merge conflict (mergeStateStatus DIRTY)' ;;
      *) stop 5 "unexpected merge state '$MS' before merge" ;;
    esac
  done
  if [ "$behind" = true ]; then
    note "origin/$LAND_BASE moved again; another update round"
    continue
  fi
  [ "$ready" = true ] || stop 4 "timed out waiting for mergeability (last state $MS)"
  break
done

# ---- 6. merge pinned, then verify against the same pin ------------------------
note "merging $PIN with --match-head-commit"
MERGE_SENT=true
merge_code=0
merge_output="$(gh_cmd pr merge "$PR" --squash --match-head-commit "$PIN" 2>&1)" || merge_code=$?
deadline

bad_merge_commit=false
i=1
while [ "$i" -le "$LAND_MERGE_POLLS" ]; do
  [ "$i" -eq 1 ] || pause
  deadline
  progress "$i" "$LAND_MERGE_POLLS" 'verifying the merge'
  i=$((i + 1))
  JSON="$(gh_cmd pr view "$PR" --json state,headRefOid,mergeCommit 2>/dev/null)" || { deadline; continue; }
  printf '%s' "$JSON" | jq -e 'type == "object"' >/dev/null 2>&1 || continue
  field '.headRefOid'; HEAD="$FIELD"
  is_sha "$HEAD" || stop 5 'malformed SHA in PR headRefOid after merge'
  field '.state'; STATE="$FIELD"
  case "$STATE" in
    MERGED)
      [ "$HEAD" = "$PIN" ] || stop 5 "merged head $HEAD differs from the verified head $PIN; do not mark Done"
      MERGED_SEEN=true
      field '.mergeCommit.oid'; oid="$FIELD"
      if is_sha "$oid"; then
        # Exit 9 is never converted to the deadline exit: the PR is MERGED, so
        # an unreadable tree is an unverified landing, not a retryable timeout.
        fetch_cmd --quiet --no-tags -- origin "$oid" || stop 9 "MERGED but could not read merge commit $oid; do not mark Done, do NOT auto-revert, escalate to Human Review"
        landed_tree="$(git rev-parse --verify --quiet "$oid^{tree}")" || stop 9 'MERGED but could not read merge tree; do not mark Done, do NOT auto-revert, escalate to Human Review'
        pinned_tree="$(git rev-parse --verify --quiet "$PIN^{tree}")" || stop 9 'MERGED but could not read pinned tree; do not mark Done, do NOT auto-revert, escalate to Human Review'
        [ "$landed_tree" = "$pinned_tree" ] || stop 9 "MERGED but the merge commit $oid tree $landed_tree differs from the pinned head $PIN tree $pinned_tree; do not mark Done, do NOT auto-revert, escalate to Human Review"
        printf 'land: update chain: %s\n' "${chain:-none}"
        printf 'land: merged and verified: head %s landed as %s\n' "$PIN" "$oid"
        exit 0
      fi
      bad_merge_commit=true ;;   # possibly not populated yet; keep polling
    CLOSED) stop 5 'PR closed without merging' ;;
    OPEN)
      [ "$HEAD" = "$PIN" ] || stop 5 "head changed from $PIN to $HEAD after the merge command"
      [ "$merge_code" -eq 0 ] || stop 5 "merge refused (exit $merge_code): $merge_output" ;;
    *) stop 5 "unknown PR state '$STATE' after merge" ;;
  esac
done
[ "$bad_merge_commit" = false ] || stop 5 'merge not verified: PR MERGED but mergeCommit is missing or malformed'
[ "$merge_code" -eq 0 ] || stop 5 "merge refused (exit $merge_code): $merge_output"
stop 4 'timed out waiting for the merge to be confirmed'
