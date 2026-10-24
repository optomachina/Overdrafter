#!/usr/bin/env bash
H=bcb559ccb838d8cca876a3484f2e728a4d6e956e
for i in $(seq 1 23); do
  cur=$(gh pr view 813 -R optomachina/Overdrafter --json headRefOid --jq .headRefOid 2>&1)
  echo "$(date +%T) poll $i head=$cur"
  [ -n "$cur" ] && [ "$cur" != "$H" ] && [ ${#cur} -eq 40 ] && { echo "NEWHEAD $cur"; exit 0; }
  sleep 120
done
echo TIMEOUT
