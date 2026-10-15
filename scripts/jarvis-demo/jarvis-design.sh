#!/usr/bin/env bash
# Phone-trigger wrapper for the Jarvis demo (OVD-765). Install as
# ~/overnight/jarvis/bin/jarvis-design (symlink). Local only: no network, no SMS.
set -u

export JARVIS_DEMO_ENABLED=1
export JARVIS_DEMO_SOURCE="${JARVIS_DEMO_SOURCE:-hermes}"

if [ -z "${JARVIS_DEMO_REPO:-}" ]; then
  src="${BASH_SOURCE[0]}"
  while [ -L "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" && pwd)"
    src="$(readlink "$src")"
    case "$src" in /*) ;; *) src="$dir/$src" ;; esac
  done
  JARVIS_DEMO_REPO="$(cd -P "$(dirname "$src")" && pwd)"
fi
demo="$JARVIS_DEMO_REPO/jarvis-demo.mjs"
root="${JARVIS_DEMO_ROOT:-$HOME/overnight/jarvis}"

json_field() { # json_field <field>; reads JSON on stdin
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];if(v!==undefined)console.log(v)}catch{}})' "$1"
}

req="$(node "$demo" request "$*")"
req_status=$?
printf '%s\n' "$req"
if [ "$req_status" -ne 0 ]; then
  echo "jarvis-design: request refused" >&2
  exit 1
fi
id="$(printf '%s' "$req" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).request.id)}catch{}})')"
if [ -z "$id" ]; then
  echo "jarvis-design: no request id in response" >&2
  exit 1
fi

out="$(node "$demo" work)"
work_status=$?
printf '%s\n' "$out"
state="$(printf '%s' "$out" | json_field state)"
ran_id="$(printf '%s' "$out" | json_field id)"
if [ -n "$ran_id" ] && [ "$ran_id" != "$id" ]; then
  echo "jarvis-design: worker ran older queued request $ran_id, not $id; run jarvis-design again" >&2
  exit 1
fi
run_dir="$root/runs/$id"
echo "result: $run_dir/result.json"
echo "assembly.png: $run_dir/assembly.png"
if [ "$work_status" -ne 0 ] || [ "$state" != "verified" ]; then
  echo "jarvis-design: work not verified (state=${state:-unknown})" >&2
  exit 1
fi
