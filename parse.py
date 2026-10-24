import json,sys,re
def load(f):
    t=open(f).read()
    for s in (t, t[t.find('['):], t[t.find('{'):]):
        try: return json.loads(s)
        except Exception: pass
    m=re.search(r'(\[.*\]|\{.*\})', t, re.S); return json.loads(m.group(1))
kind=sys.argv[1]
for f in sys.argv[2:]:
    d=load(f); print("==",f)
    if kind=="c":
        if isinstance(d,dict): d=d.get('comments') or d.get('items') or d.get('data') or d
        for c in d:
            if c['user']['login']=='optomachina': print(c['id'],c['created_at'],c['body'][:160].replace('\n',' '))
    else:
        runs=d['check_runs'] if isinstance(d,dict) else d
        print(len(runs),"runs")
        for r in runs: print(r['name'],r['status'],r['conclusion'],r.get('html_url') if r['name'] in('ci','test') else '')
