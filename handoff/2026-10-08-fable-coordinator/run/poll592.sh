#!/bin/bash
SHA=30779940edb615725c06d41e34fe23ac14a9e72b
for i in $(seq 1 14); do
  r=$(curl -sS "https://api.github.com/repos/optomachina/Overdrafter/commits/$SHA/check-runs?per_page=100")
  n=$(echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);c=d.get('check_runs',[]);print(len(c),sum(1 for x in c if x['status']!='completed'))" 2>&1)
  echo "$i $n"
  tot=${n%% *}; pend=${n##* }
  if [[ "$tot" =~ ^[0-9]+$ ]] && [ "$tot" -gt 8 ] && [ "$pend" = "0" ]; then break; fi
  sleep 30
done
echo "$r" | python3 -c "import sys,json;[print(x['id'],x['name'],x['status'],x['conclusion'],(x.get('output') or {}).get('title')) for x in json.load(sys.stdin).get('check_runs',[])]"
