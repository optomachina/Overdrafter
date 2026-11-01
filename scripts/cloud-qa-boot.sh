#!/usr/bin/env bash
# Boot the authenticated browser lane inside a Claude Code cloud session.
#
# Independent QA sessions on PR #894 stopped before boot (see the PR's DIAGNOSIS
# comment). This script handles the cloud-only gaps between a fresh container and
# what CI's `browser-test (authenticated)` job gets from its runner. It changes no
# test, gate or Playwright setting:
#
#   1. GitHub: `gh auth status` always fails in cloud sessions, because the egress
#      proxy injects the real credential and GH_TOKEN holds only a placeholder.
#      Probe the REST read QA actually uses. Push permission is reported but only
#      required when QA_REQUIRE_PUSH=1 (read-only reviewer sessions stay usable).
#   2. Docker: the daemon is installed but not running. Start it when root.
#   3. Supabase CLI: not on PATH. Install the version CI pins (2.78.1) as a binary.
#   4. Playwright: the image ships one Chromium revision under /opt/pw-browsers;
#      the repo's pinned Playwright expects another. Alias the expected revision
#      directory to the installed one (outside the repository).
#   5. Chromium refuses its sandbox when run as root, and the repo keeps
#      chromiumSandbox: true. Run Playwright as an unprivileged user instead of
#      turning the sandbox off.
#   6. Images: some cloud kernels have no IPv6, and Realtime binds its endpoint
#      with socket_opts: [:inet6] (eafnosupport). Edge runtime fetches its
#      bootstrap imports through the egress proxy, whose CA it does not trust.
#      Re-tag local copies of the CLI-pinned images with an IPv4 bind and the
#      proxy CA ($QA_PROXY_CA). Nothing in the repo or the registry changes.
#
# Usage (from the repository root, after `npm ci`):
#   bash scripts/cloud-qa-boot.sh check            # steps 1-4, then stop
#   bash scripts/cloud-qa-boot.sh run [playwright args...]
#       steps 1-4 and 6, then CI's order: `supabase start`, `supabase db reset`,
#       `npm run seed:dev`, then
#       `npx playwright test <args>` as user "qa" from a copy at $QA_COPY_DIR.
#
# `check` is not read-only: it may start dockerd, install the CLI under $SHIM_DIR
# and add browser symlinks under $PLAYWRIGHT_BROWSERS_PATH. The browser alias runs
# the image's Chromium build, not the one CI pins; record that in QA verdicts.
#
# Never prints environment values. Targets only the local loopback Supabase stack.
set -euo pipefail

REPO="${QA_GITHUB_REPO:-optomachina/Overdrafter}"
# Default matches supabase/setup-cli in .github/workflows/ci.yml. Override with
# QA_SUPABASE_CLI_VERSION to reuse images already pulled (each CLI version pins its
# own image tags, about 2-3 GB, and registry pulls can hit a data limit).
SUPABASE_CLI_VERSION="${QA_SUPABASE_CLI_VERSION:-2.78.1}"
QA_USER="${QA_USER:-qa}"
QA_COPY_DIR="${QA_COPY_DIR:-/tmp/qa-repo}"
BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
SHIM_DIR="${QA_SHIM_DIR:-/usr/local/lib/cloud-qa-boot/bin}"
PROXY_CA="${QA_PROXY_CA:-/root/.ccr/ca-bundle.crt}"
REALTIME_VERSION=""
RETAG_CHANGE=""

step() { printf '[cloud-qa-boot] %s: %ss %s\n' "$1" "$2" "$3"; }
now() { date +%s; }

check_github() {
  local t; t=$(now)
  local push
  if ! push=$(gh api "repos/$REPO" --jq '.permissions.push' 2>/dev/null); then
    step github "$(( $(now) - t ))" "FAIL: REST read of repos/$REPO failed"
    return 1
  fi
  if [[ "$push" != "true" ]]; then
    if [[ "${QA_REQUIRE_PUSH:-0}" = "1" ]]; then
      step github "$(( $(now) - t ))" "FAIL: no push permission on $REPO"
      return 1
    fi
    step github "$(( $(now) - t ))" "ok (REST read; no push permission; gh auth status is not used)"
    return
  fi
  step github "$(( $(now) - t ))" "ok (REST read + push; gh auth status is not used)"
}

ensure_docker() {
  local t; t=$(now)
  if docker info >/dev/null 2>&1; then step docker 0 "ok (already running)"; return; fi
  if [[ "$(id -u)" != "0" ]] || ! command -v dockerd >/dev/null; then
    step docker 0 "FAIL: daemon not running and cannot be started here"; return 1
  fi
  nohup dockerd >/tmp/cloud-qa-boot-dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && { step docker "$(( $(now) - t ))" "ok (started dockerd)"; return; }
    sleep 1
  done
  step docker "$(( $(now) - t ))" "FAIL: dockerd did not answer in 60s (/tmp/cloud-qa-boot-dockerd.log)"
  return 1
}

ensure_supabase_cli() {
  local t; t=$(now)
  mkdir -p "$SHIM_DIR"
  if ! command -v supabase >/dev/null || [[ "$(supabase --version 2>/dev/null)" != "$SUPABASE_CLI_VERSION" ]]; then
    # Fetch once with this shell's npm (which has the proxy CA config), then copy the
    # standalone binary so the unprivileged user never needs npm or registry access.
    # Newer packages put a JS launcher on PATH and the binary in a platform package.
    local modules bin=""
    # The inner sh expands these, so the single quotes are intended.
    # shellcheck disable=SC2016
    modules=$(npm exec --yes --package="supabase@$SUPABASE_CLI_VERSION" -- \
      sh -c 'p=$(readlink -f "$(command -v supabase)"); while [ "$p" != / ] && [ "$(basename "$p")" != node_modules ]; do p=$(dirname "$p"); done; echo "$p"')
    [[ "$modules" != "/" ]] || { step supabase-cli "$(( $(now) - t ))" "FAIL: supabase launcher is not inside node_modules"; return 1; }
    while IFS= read -r f; do
      [[ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = '177ELF' ]] && { bin=$f; break; }
    done < <(find "$modules" -type f -name supabase)
    [[ -n "$bin" ]] || { step supabase-cli "$(( $(now) - t ))" "FAIL: no supabase binary in $modules"; return 1; }
    install -m 755 "$bin" "$SHIM_DIR/supabase"
  fi
  export PATH="$SHIM_DIR:$PATH"
  local v; v=$(supabase --version 2>/dev/null || true)
  if [[ "$v" != "$SUPABASE_CLI_VERSION" ]]; then
    step supabase-cli "$(( $(now) - t ))" "FAIL: expected $SUPABASE_CLI_VERSION, got '${v:-none}'"; return 1
  fi
  step supabase-cli "$(( $(now) - t ))" "ok ($v)"
}

ensure_playwright_browsers() {
  local t; t=$(now)
  local want have kind
  for kind in chromium chromium_headless_shell; do
    # browsers.json is not in playwright-core's exports map; read the file directly.
    want=$(node -e "const r=JSON.parse(require('fs').readFileSync('node_modules/playwright-core/browsers.json','utf8')).browsers.find(b=>b.name===process.argv[1].replace(/_/g,'-')); process.stdout.write(r?r.revision:'')" "$kind")
    [[ -n "$want" ]] || continue
    [[ -d "$BROWSERS/$kind-$want" ]] && continue
    have=$(find "$BROWSERS" -maxdepth 1 -name "$kind-[0-9]*" -type d | sort -V | tail -1)
    if [[ -z "$have" ]]; then
      step playwright "$(( $(now) - t ))" "FAIL: no $kind build under $BROWSERS"; return 1
    fi
    ln -sfn "$have" "$BROWSERS/$kind-$want"
    echo "[cloud-qa-boot] playwright: aliased $kind-$want -> $(basename "$have")"
  done
  step playwright "$(( $(now) - t ))" "ok ($(npx playwright --version))"
}

pinned_image() {
  # The CLI embeds a Dockerfile naming the image tags it starts.
  grep -ao "FROM supabase/$1:v[0-9.]*" "$(command -v supabase)" | head -1 | sed 's/^FROM /public.ecr.aws\//'
}

# Re-tag a local copy of a pinned image with one container-local fix. The label
# makes it idempotent; the registry image and the repo stay unchanged.
retag_image() {
  local image=$1 label=$2 cid; shift 2
  [[ -n "$image" ]] || return 1
  [[ "$(docker image inspect -f "{{index .Config.Labels \"$label\"}}" "$image" 2>/dev/null)" = "1" ]] && return
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
  cid=$(docker create "$image")
  "$@" "$cid" || { docker rm "$cid" >/dev/null; return 1; }
  docker commit --change "LABEL $label=1" ${RETAG_CHANGE:+--change "$RETAG_CHANGE"} "$cid" "$image" >/dev/null
  docker rm "$cid" >/dev/null
}

realtime_bind_ipv4() {
  local cid=$1 exs; exs=$(mktemp -d)
  docker cp "$cid:/app/releases/$REALTIME_VERSION/runtime.exs" "$exs/runtime.exs"
  grep -q 'socket_opts: \[:inet6\]' "$exs/runtime.exs" || return 1
  sed -i 's/socket_opts: \[:inet6\]/socket_opts: [:inet]/' "$exs/runtime.exs"
  docker cp "$exs/runtime.exs" "$cid:/app/releases/$REALTIME_VERSION/runtime.exs"
  rm -rf "$exs"
}

edge_trust_proxy_ca() { docker cp "$PROXY_CA" "$1:/usr/local/share/cloud-qa-boot-ca.crt"; }

ensure_local_images() {
  local t; t=$(now)
  local image notes=()
  if [[ ! -e /proc/net/if_inet6 ]]; then
    # Realtime binds its endpoint with socket_opts: [:inet6] and has no override.
    image=$(pinned_image realtime); REALTIME_VERSION=${image##*:v}
    retag_image "$image" cloud-qa-boot.ipv4 realtime_bind_ipv4 || {
      step images "$(( $(now) - t ))" "FAIL: could not re-tag ${image:-realtime} for IPv4"; return 1; }
    notes+=("realtime binds IPv4")
  fi
  if [[ -f "$PROXY_CA" ]]; then
    # Edge runtime fetches its bootstrap imports through the egress proxy.
    image=$(pinned_image edge-runtime)
    RETAG_CHANGE="ENV DENO_TLS_CA_STORE=system SSL_CERT_FILE=/usr/local/share/cloud-qa-boot-ca.crt" \
      retag_image "$image" cloud-qa-boot.proxy-ca edge_trust_proxy_ca || {
      step images "$(( $(now) - t ))" "FAIL: could not re-tag ${image:-edge-runtime} with the proxy CA"; return 1; }
    notes+=("edge-runtime trusts the proxy CA")
  fi
  step images "$(( $(now) - t ))" "ok (${notes[*]:-no local changes needed})"
}

safe_copy_dir() {
  # Refuse to rm -rf the root, the checkout or any of its ancestors.
  local dir repo
  dir=$(realpath -m "$QA_COPY_DIR"); repo=$(realpath .)
  if [[ "$dir" = "/" || "$repo" = "$dir" || "$repo" = "$dir"/* ]]; then
    echo "[cloud-qa-boot] refusing QA_COPY_DIR=$QA_COPY_DIR (root, repo or an ancestor)" >&2
    return 1
  fi
}

prepare_unprivileged_copy() {
  local t; t=$(now)
  safe_copy_dir
  id "$QA_USER" >/dev/null 2>&1 || useradd -m "$QA_USER"
  getent group docker >/dev/null || groupadd docker
  usermod -aG docker "$QA_USER"
  local sock=/var/run/docker.sock
  [[ -S "$sock" ]] && chgrp docker "$sock" && chmod 660 "$sock"
  rm -rf "$QA_COPY_DIR"
  cp -a . "$QA_COPY_DIR"
  chown -R "$QA_USER:$QA_USER" "$QA_COPY_DIR"
  step copy "$(( $(now) - t ))" "ok ($QA_COPY_DIR owned by $QA_USER)"
}

as_qa() {
  local cmd=$1
  sudo -u "$QA_USER" -H env PATH="$SHIM_DIR:$PATH" PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" \
    bash -c "cd $(printf '%q' "$QA_COPY_DIR") && $cmd"
}

timed() {
  local name=$1; shift
  local t; t=$(now)
  local rc=0
  "$@" || rc=$?
  step "$name" "$(( $(now) - t ))" "exit=$rc"
  return "$rc"
}

main() {
  local mode="${1:-check}"; shift || true
  [[ -f package.json ]] && [[ -d node_modules ]] || { echo "run from the repo root after npm ci" >&2; exit 2; }
  check_github
  ensure_docker
  ensure_supabase_cli
  ensure_playwright_browsers
  [[ "$mode" = "check" ]] && return
  [[ "$mode" = "run" ]] || { echo "usage: $0 check|run [playwright args]" >&2; exit 2; }
  [[ "$(id -u)" = "0" ]] || { echo "run mode needs root to create the unprivileged user" >&2; exit 2; }
  prepare_unprivileged_copy
  # Supabase output carries local demo keys; keep it out of the transcript.
  ensure_local_images
  timed supabase-start as_qa "supabase start >/tmp/cloud-qa-boot-supabase.log 2>&1"
  # CI resets before seeding; without it a reused Docker volume keeps an older
  # head's schema and the seed lands on stale data.
  timed db-reset as_qa "supabase db reset >/tmp/cloud-qa-boot-reset.log 2>&1"
  timed seed-dev as_qa "npm run seed:dev >/tmp/cloud-qa-boot-seed.log 2>&1"
  local args; args=$(printf '%q ' "$@")
  timed playwright as_qa "npx playwright test $args"
}

main "$@"
