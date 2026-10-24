#!/usr/bin/env bash
H=b5f2340c0f787e006e474a7eac43e0b066ed5c2d
for i in $(seq 1 22); do
  out=$(gh api "repos/optomachina/Overdrafter/commits/$H/check-runs?per_page=100" --jq '.check_runs[]|select(.status!="completed")|.name')
  echo "$(date +%T) poll $i pending: ${out//$'\n'/, }"
  [ -z "$out" ] && { echo ALL-COMPLETE; break; }
  sleep 120
done
gh api "repos/optomachina/Overdrafter/commits/$H/check-runs?per_page=100" --jq '.check_runs[]|[.name,.status,.conclusion,.completed_at,.html_url]|@tsv'
