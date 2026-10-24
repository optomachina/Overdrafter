import sys; sys.path.insert(0,'/workspace/qa-batch/tools'); from j import load
n,prf,cf,rf=sys.argv[1:5]
pr=load(prf)
print(pr['title'],'|',pr['state'],pr['head']['sha'],pr['head']['ref'],'base',pr['base']['sha'],pr['mergeable_state'],[l['name'] for l in pr['labels']])
open(f'/workspace/qa-batch/{n}-body.md','w').write(pr['body'] or '')
print('---REVIEWS')
for r in load(rf):
    print(r['user']['login'],r['state'],r['commit_id'],r['submitted_at'],(r['body'] or '')[:150].replace('\n',' '))
print('---COMMENTS')
for c in load(cf):
    u=c['user']['login']
    if u in ('vercel[bot]',): continue
    b=c['body'] or ''
    if u in('coderabbitai[bot]','sonarqubecloud[bot]'): b=b[:120]
    print('##',c['id'],u,c['created_at'],b.replace('\n',' ')[:1500])
