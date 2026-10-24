#!/usr/bin/env bash
H=bcb559ccb838d8cca876a3484f2e728a4d6e956e
for i in $(seq 1 20); do
  out=$(gh api "repos/optomachina/Overdrafter/commits/$H/check-runs?per_page=100" --jq '.check_runs[]|select(.status!="completed")|.name')
  echo "$(date +%T) poll $i pending: ${out//$'\n'/, }"
  [ -z "$out" ] && { echo ALL-COMPLETE; break; }
  sleep 120
done
gh api "repos/optomachina/Overdrafter/commits/$H/check-runs?per_page=100" --jq '.check_runs[]|[.name,.status,.conclusion,.completed_at,.html_url]|@tsv'
