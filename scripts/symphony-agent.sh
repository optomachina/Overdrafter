#!/bin/sh
# Controller metadata is supplied by the sole scheduler, never guessed from issue prose.
set -eu
issue_id=$(basename "$PWD")
case "$issue_id" in
  OVD-[0-9]*) ;;
  *) printf '%s\n' "agent-launch: workspace must identify an OVD issue" >&2; exit 1 ;;
esac
: "${OVD_AGENT_RUN_STORE:?Set the canonical project run store}"
: "${OVD_AGENT_ASSIGNMENT_DIR:?Set the controller assignment directory}"
# A controller-owned absolute path prevents a retained checkout selecting old code.
: "${OVD_AGENT_LAUNCHER:?Set the maintained absolute launch.py path}"
case "$OVD_AGENT_LAUNCHER" in
  /*) ;;
  *) printf '%s\n' "agent-launch: launcher path must be absolute" >&2; exit 1 ;;
esac
exec python3 "$OVD_AGENT_LAUNCHER" launch \
  --run "$OVD_AGENT_RUN_STORE" \
  --assignment "$OVD_AGENT_ASSIGNMENT_DIR/$issue_id.json" \
  --workspace "$PWD" --issue-id "$issue_id" -- codex app-server \
  -c 'project_doc_fallback_filenames=[]' -c project_doc_max_bytes=32768 \
  -c 'model="gpt-6-astra"' -c 'model_reasoning_effort="medium"'
