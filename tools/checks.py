import sys; sys.path.insert(0,'/workspace/qa-batch/tools'); from j import load
d=load(sys.argv[1]); print('total',d.get('total_count'))
for c in sorted(d['check_runs'],key=lambda c:c['name']):
    print(f"{c['name'][:55]:55} {c['status']:10} {str(c['conclusion']):10} {c['head_sha'][:8]} {c['app']['slug'][:14]:14} {c.get('details_url','')}")
if len(sys.argv)>2:
    s=load(sys.argv[2]); print('combined',s['state'])
    for x in s['statuses']: print(' ',x['context'],x['state'],(x.get('description') or '')[:80])
