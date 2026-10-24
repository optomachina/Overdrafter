import json,subprocess,sys
R='provider-integrations/provider-registry.v1.json'
base=open(R).read()
def P(k):
    d=json.loads(base); return d,{p['key']:p for p in d['providers']}
JWT='eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk'
AKIA='AKIAIOSFODNN7EXAMPLE'
GHP='ghp_'+'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
GHO='gho_'+'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'
SK='sk-'+'proj4f8a9B2c7D1e6F3g5H0iJkLmNoPq'
RND='q7Rz2Kp9Xv4Lm8Nw3Bt6Yc1Hd5Fg0Js2Ua'
def reg(name,fn,expect_fail=True):
    d,m=P(0); fn(d,m); open(R,'w').write(json.dumps(d,indent=2)+'\n')
    r=subprocess.run(['npm','run','-s','provider:check'],capture_output=True,text=True)
    open(R,'w').write(base)
    out=(r.stdout+r.stderr).strip().splitlines()
    msg=next((l for l in out if 'Error' in l or 'rejects' in l or 'invalid' in l or 'requires' in l or 'collid' in l),out[-1] if out else '')
    ok=(r.returncode!=0)==expect_fail
    print(f"[{'OK' if ok else 'UNEXPECTED'}] {name}: rc={r.returncode} :: {msg[:200]}")
def sec(m,k): return m[k]['sessionSecrets'][0]
def manifest(name,val,expect_fail=True):
    f='provider-integrations/rmfg/manifest.v1.json'; b=open(f).read(); d=json.loads(b)
    d['displayName']=d.get('displayName','x')+' '+val if 'displayName' in d else val
    d['qaPlanted']=val
    open(f,'w').write(json.dumps(d,indent=2)+'\n')
    r=subprocess.run(['npm','run','-s','provider:check'],capture_output=True,text=True); open(f,'w').write(b)
    out=(r.stdout+r.stderr).strip().splitlines()
    print(f"[{'OK' if (r.returncode!=0)==expect_fail else 'UNEXPECTED'}] manifest {name}: rc={r.returncode} :: {(out[-1] if out else '')[:160]}")
reg('no _SECRET_NAME suffix',lambda d,m: sec(m,'fictiv').update(secretNameEnv='FICTIV_STORAGE_STATE'))
reg('suffix-in-middle',lambda d,m: sec(m,'fictiv').update(secretNameEnv='FICTIV_SECRET_NAME_X'))
reg('reserved WORKER_MODE',lambda d,m: sec(m,'fictiv').update(secretNameEnv='WORKER_MODE'))
reg('reserved SUPABASE_SERVICE_ROLE_SECRET_NAME',lambda d,m: sec(m,'fictiv').update(secretNameEnv='SUPABASE_SERVICE_ROLE_SECRET_NAME'))
reg('reserved OPENAI_API_KEY_SECRET_NAME (scraped)',lambda d,m: sec(m,'fictiv').update(secretNameEnv='OPENAI_API_KEY_SECRET_NAME'))
reg('reserved mountEnv PATH',lambda d,m: sec(m,'fictiv').update(mountEnv='PATH'))
reg('reserved mountEnv SUPABASE_SERVICE_ROLE_KEY',lambda d,m: sec(m,'fictiv').update(mountEnv='SUPABASE_SERVICE_ROLE_KEY'))
reg('cross-provider same secretNameEnv',lambda d,m: sec(m,'weerg').update(secretNameEnv='FICTIV_STORAGE_STATE_SECRET_NAME'))
reg('cross-provider same mountPath',lambda d,m: sec(m,'weerg').update(mountPath='/var/secrets/quickparts-storage-state/storage-state.json'))
reg('cross-provider steals XOMETRY_STORAGE_STATE_SECRET_NAME',lambda d,m: sec(m,'weerg').update(secretNameEnv='XOMETRY_STORAGE_STATE_SECRET_NAME'))
reg('rmfg live, no secrets, no egress key',lambda d,m: (m['rmfg'].update(liveAdapter=True), m['rmfg'].pop('egress')))
reg('rmfg live, no secrets, egress none, no justification',lambda d,m: m['rmfg'].update(liveAdapter=True))
reg('rmfg live, optional-only secret, no justification',lambda d,m: m['rmfg'].update(liveAdapter=True,sessionSecrets=[{'secretNameEnv':'RMFG_STORAGE_STATE_SECRET_NAME','mountEnv':'RMFG_STORAGE_STATE_JSON','requiredWhenListed':False}]))
reg('rmfg live, egress null',lambda d,m: m['rmfg'].update(liveAdapter=True,egress=None,sessionlessJustification='a real reason for sessionless listing'))
reg('justification empty',lambda d,m: m['rmfg'].update(liveAdapter=True,sessionlessJustification=''))
reg('justification 30 spaces',lambda d,m: m['rmfg'].update(liveAdapter=True,sessionlessJustification=' '*30))
reg('justification tabs/newlines 25',lambda d,m: m['rmfg'].update(liveAdapter=True,sessionlessJustification='\t\n '*9))
reg('justification "x"*20 junk',lambda d,m: m['rmfg'].update(liveAdapter=True,sessionlessJustification='x'*20),expect_fail=False)
reg('justification on non-live',lambda d,m: m['rmfg'].update(sessionlessJustification='a real reason for sessionless listing'))
reg('manualDeploy on fictiv (required secret)',lambda d,m: sec(m,'fictiv').update(manualDeploy=True),expect_fail=None)
for n,v in [('JWT',JWT),('AKIA',AKIA),('ghp_',GHP),('gho_',GHO),('sk-',SK),('random',RND)]:
    reg('planted '+n+' in justification',lambda d,m,v=v: m['xometry'].update(sessionlessJustification='reason '+v))
    reg('planted '+n+' as secretNameEnv value',lambda d,m,v=v: sec(m,'fictiv').update(secretNameEnv=v))
    manifest(n,v)
for n,v in [('long legit name','QUICKPARTS_PORTAL_STORAGE_STATE_SECRET_NAME'),('mount path','/var/secrets/quickparts-portal-storage-state/storage-state.json')]:
    reg('FP '+n,lambda d,m,v=v: sec(m,'quickparts').update(**({'secretNameEnv':v} if 'NAME' in v else {'mountPath':v})),expect_fail=False)
