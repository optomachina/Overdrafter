#!/usr/bin/env bash
# Copy the last screencast frame of every Playwright trace under an evidence
# dir to <dir>/shots/<test dir>.jpeg: the resulting state of each journey.
# A passing run keeps traces only when driven with `verify.sh ... -- --trace on`.
# Usage: trace-shots.sh <evidence dir>
# Exit: 0 one shot per trace, 1 a trace without frames, 2 usage or no traces.
set -euo pipefail

DIR="${1-}"
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "usage: trace-shots.sh <evidence dir>" >&2; exit 2; }
command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 2; }

mkdir -p "$DIR/shots"
found=0 bad=0
while IFS= read -r -d '' zip; do
  found=$((found + 1))
  name="$(basename "$(dirname "$zip")")"
  # Frame names end in a millisecond timestamp, so the numeric sort's last one is the final state.
  frame="$(unzip -Z1 "$zip" 'resources/*.jpeg' 2>/dev/null | sort -t- -k2 -n | tail -n 1 || true)"
  if [ -z "$frame" ]; then echo "FAIL no screencast frames in $zip"; bad=1; continue; fi
  unzip -p "$zip" "$frame" > "$DIR/shots/$name.jpeg"
  echo "shot: $DIR/shots/$name.jpeg"
done < <(find "$DIR" -name trace.zip -print0 | sort -z)

[ "$found" -gt 0 ] || { echo "no trace.zip under $DIR (drive with: verify.sh ... -- --trace on)" >&2; exit 2; }
exit "$bad"
