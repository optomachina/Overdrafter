"""Independently reconstruct executor-reported bytes and engineering evidence; no CAD execution."""
import base64, hashlib, json, math, subprocess
from pathlib import Path, PureWindowsPath
H = Path(__file__).resolve().parent
REPO = H.parent.parent
checks = []
def sha(b): return hashlib.sha256(b).hexdigest()
def check(name, value):
    checks.append({'name': name, 'passed': bool(value)})
    if not value: raise AssertionError(name)
def norm(p): return str(PureWindowsPath(p)).lower()
p = json.loads((H/'live-receipt.json').read_text(encoding='utf-8-sig'))
records = p['records']
raw = {}; artifacts = {}
for r in records:
    b = base64.b64decode(r['base64']); check('raw:'+r['path'],len(b)==r['bytes'] and sha(b)==r['sha256'])
    check('unique:'+r['path'], norm(r['path']) not in raw)
    raw[norm(r['path'])] = b; artifacts[norm(r['path'])] = r

def named(suffix):
    candidates = [(k,b) for k,b in raw.items() if k.endswith(norm(suffix))]
    check('one_record:'+suffix,len(candidates)==1)
    return candidates[0]
def read(suffix): return json.loads(named(suffix)[1].decode('utf-8-sig'))
l = read('lifecycle-result.json'); a,b = l['attempts']
check('passed_bounded_recovery', l['outcome']=='passed' and l['interruptionRecovery']=='passed_readonly_assembly_closure' and l['qualification']=='incomplete' and not l['recovery_required'])
check('live_source_commit',l['sourceCommit']=='7783ce2de30c8ffc5461e4996bc1c1bc3e399495')
paths = ['session-lifecycle/'+n for n in ['lifecycle.ps1','NativeSessionProbe.cs','PreparedCylinder.cs','InterruptionCase.ps1','AssemblyRecovery.cs']] + ['file-admission/SharedFilePredicates.cs','file-admission/OwnedProcess.ps1'] + ['prepared-dimension/'+n for n in ['PreparedDimensionProbe.cs','PreparedPackage.cs','PartGeometry.cs']]
source = {Path(x).name:sha(subprocess.check_output(['git','show',l['sourceCommit']+':scripts/native/'+x],cwd=REPO)) for x in paths}
check('ten_git_source_hashes',len(l['sourceHashes'])==10 and {x['name']:x['sha256'] for x in l['sourceHashes']}==source)
check('distinct_attempts',a['role']=='interrupted' and b['role']=='recovery' and a['id']!=b['id'] and a['directory']!=b['directory'])
check('fresh_process_identity',a['native']['pid']!=b['native']['pid'] and int(a['native']['ticks'])<int(b['native']['ticks']) and a['native']['session']==b['native']['session'])
check('interrupted_history_retained',a['outcome']=='interrupted' and a['terminationRequested'] and a['exitCode']!=0)
check('normal_recovery_exit',b['outcome']=='verified_readonly_recovery' and not b['terminationRequested'] and b['exitCode']==0 and l['nativeExit']==0)
check('originals_preserved',len(l['sourcesBefore'])==3 and l['sourcesBefore']==l['sourcesAfter'])
expected = [('90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a',59987),('e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa',56144),('b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898',56171)]
check('exact_original_identities',[(x['sha256'],x['bytes']) for x in l['sourcesBefore']]==expected)
for attempt in (a,b):
    role=attempt['role']; mpath,mraw=named(role+'/input.json');m=json.loads(mraw)
    _,result=named(role+'/attempt-result.json')
    check(role+'_manifest_binding',sha(mraw)==attempt['inputManifestSha256'] and m['id']==attempt['id'] and m['role']==role and m['qualification']=='prepared_three_file_assembly_only' and m['sources']==l['sourcesBefore'] and m['baseline']==l['sourcesBefore'][0])
    check(role+'_three_private_inputs',attempt['inputs']==attempt['inputsAfter']==m['inputs'] and [(x['sha256'],x['bytes']) for x in m['inputs']]==expected and all(norm(x['path']).startswith(norm(attempt['directory'])+'\\') for x in m['inputs']) and not set(norm(x['path']) for x in m['inputs']) & set(norm(x['path']) for x in l['sourcesBefore']))
    check(role+'_terminal_record',sha(result)==attempt['resultSha256'] and json.loads(result)==dict(attempt,resultSha256=None))
_,cpbytes=named('interrupted/pre-interrupt.json');cp=json.loads(cpbytes)
check('immutable_checkpoint',sha(cpbytes)==a['checkpointSha256'] and cp['attempt']==a['id'] and cp['native']==a['native'] and cp['inputManifestSha256']==a['inputManifestSha256'] and cp['sourceHashes']==l['sourceHashes'] and cp['binarySha256']==l['binarySha256'] and not cp['interruptedSaveRecovery'])
for suffix,attempt,count in [('interrupted-open.stdout.txt',a,3),('before-interrupt.stdout.txt',a,3),('recovery-open.stdout.txt',b,3),('recovery-close-fixture.stdout.txt',b,0)]:
    d=read(suffix);f=d['fixture'];c=f['checks']
    check(suffix+'_identity',d['outcome']=='passed' and d['apiPid']==attempt['native']['pid'] and d['expectedTicks']==attempt['native']['ticks'] and d['revision']=='30.5.0' and d['startupCompleted'] and not d['exitAppRequested'])
    check(suffix+'_readonly_closure',d['documentCount']==count and f['documentCountAfter']==count and f['verified'] and f['readOnly'] and norm(f['path'])==norm(attempt['input']['path']) and f['releaseErrors']==[] and all(v is True for v in c.values()))
    mandatory=['private_three_document_closure','all_documents_readonly','component_identity_configuration_state','unchanged_fixed_transform','exact_dependency','default_configuration','assembly_rebuild','final_recovery_document_count']
    check(suffix+'_mandatory_checks',all(c.get(k) is True for k in mandatory))
    occurrences=f['recoveryOccurrences'];check(suffix+'_occurrences',len(occurrences)==2)
    for i,depth in enumerate((5,8)):
        g=f['recovery_geometry_'+str(i)];mass=g['massProperties'];expected_volume=math.pi*.01**2*depth/1000
        check(suffix+'_geometry_'+str(i),abs(g['depthMm']-depth)<=1e-7 and abs(mass[3]-expected_volume)<=1e-10 and abs(mass[4]-2*math.pi*.01*(.01+depth/1000))<=1e-9 and abs(mass[2]-depth/2000)<=1e-8)
        occ=next(x for x in occurrences if norm(x['path'])==norm(attempt['inputs'][i+1]['path']));t=occ['transform'];ex=[1,0,0,0,1,0,0,0,1,.04*i,0,0,1]
        check(suffix+'_placement_'+str(i),occ['readOnly'] and occ['fixedState'] and occ['configuration']=='Default' and norm(occ['modelPath'])==norm(occ['path']) and all(abs(v-e)<=1e-8 for v,e in zip(t,ex)))
check('checkpoint_observation_match',cp['observation']==read('before-interrupt.stdout.txt'))
for obs in l['observations']:
    d=json.loads(obs['stdout']);check('helper_completed:'+str(obs['pid']),not obs['timedOut'] and not obs['terminationRequested'] and not obs['terminated'] and obs['error'] is None and obs['pid']==d['helperPid'] and obs['exitCode']==(3 if d['outcome']=='not_ready' else 0))
supervisor=read('supervisor.json')
check('outer_normal_completion',supervisor['outcome']=='finished' and supervisor['error'] is None and supervisor['outer']['exitCode']==0 and supervisor['outer']['error'] is None and not any(supervisor['outer'][k] for k in ('timedOut','terminationRequested','terminated')))
check('empty_native_before_after',all(supervisor[t][k]==[] for t in ('before','after') for k in ('native','cim')))
check('unchanged_originals_and_policy',supervisor['before']['files']==supervisor['after']['files']==l['sourcesBefore'] and supervisor['before']['policy']==supervisor['after']['policy'])
check('supervisor_source_binding',{PureWindowsPath(x['path']).name:x['sha256'] for x in supervisor['sources']}==source)
inventory={norm(x['path']):x for x in p['inventory']}
check('inventory_unique',len(inventory)==len(p['inventory'])==58)
check('all_raw_records_bound_to_inventory',all(k in inventory and inventory[k]['sha256']==sha(v) and inventory[k]['bytes']==len(v) for k,v in raw.items()))
for attempt in (a,b):
    check(attempt['role']+'_all_private_artifact_hashes',all(inventory[norm(x['path'])]['sha256']==x['sha256'] and inventory[norm(x['path'])]['bytes']==x['bytes'] for x in attempt['inputs']))
for name,digest in source.items():
    _,data=named(name);check('executed_source_bytes:'+name,sha(data)==digest)
check('helper_binary_inventory',next(x['sha256'] for x in p['inventory'] if PureWindowsPath(x['path']).name=='NativeSessionProbe.exe')==l['binarySha256'])
(H/'validation.json').write_text(json.dumps({'scope':'byte reconstruction and executor-reported evidence consistency; no independent native execution','checks':checks},indent=2))
print(f'{len(checks)} independent evidence assertions passed.')
