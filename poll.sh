#!/bin/bash
for n in 807 825; do
 h=$(curl -s --max-time 20 https://api.github.com/repos/optomachina/Overdrafter/pulls/$n | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['head']['sha'],d['state'],'draft='+str(d['draft']))")
 s=${h%% *}
 c=$(curl -s --max-time 20 "https://api.github.com/repos/optomachina/Overdrafter/commits/$s/check-runs?per_page=100" | python3 -c "
import json,sys,collections;d=json.load(sys.stdin);L={}
for r in sorted(d['check_runs'],key=lambda r:r['started_at'] or ''): L[r['name']]=r
c=collections.Counter((r['conclusion'] or r['status']) for r in L.values());bad=[n for n,r in L.items() if r['conclusion'] not in('success','skipped','neutral')]
print(dict(c),bad)")
 k=$(curl -s --max-time 20 "https://api.github.com/repos/optomachina/Overdrafter/issues/$n/comments?per_page=100" | python3 -c "import json,sys;l=json.load(sys.stdin);print(len(l),l[-1]['created_at'],l[-1]['body'][:50].replace(chr(10),' '))")
 echo "$(date +%H:%M) #$n $h | $c | comments $k"
done
