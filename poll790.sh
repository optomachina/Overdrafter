for i in $(seq 1 10); do
  out=$(gh pr checks 790 -R optomachina/Overdrafter 2>&1 | awk -F'\t' '{print $1"\t"$2}')
  echo "[$(date +%H:%M) PT] poll $i: $(echo "$out" | awk -F'\t' '{print $2}' | sort | uniq -c | tr '\n' ' ')"
  echo "$out" | grep -qE "pending|queued|in_progress" || { echo "$out"; exit 0; }
  sleep 300
done; echo TIMEOUT
