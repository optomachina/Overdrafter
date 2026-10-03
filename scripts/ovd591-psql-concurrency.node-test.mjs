import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PsqlSession, executePhases, clientArgs, oneJson, acceptIdentity, acceptOverlap, actorResult, resultCopy, IDENTITY_SQL } from './ovd591-psql-concurrency.mjs';

const original = readFileSync(new URL('../supabase/tests/capability_runtime_persistence_concurrency.sql', import.meta.url), 'utf8');
const phases = JSON.parse(readFileSync(new URL('../supabase/tests/capability_runtime_persistence_psql.phases.json', import.meta.url), 'utf8'));
const options = '-csearch_path=public,extensions,pg_catalog -ctimezone=UTC -cstatement_timeout=20000';
const identity = pid => ({ pid, database: 'postgres', sessionUser: 'postgres', currentUser: 'postgres', serverAddress: null, clientAddress: null, backendStart: '2026-10-02T00:00:00Z' });

test('checked-in phase SQL preserves every retained source byte, 28 assertions and fixed six actor cases', () => {
  assert.equal(createHash('sha256').update(original).digest('hex'), phases.originalSha256);
  // OVERLAPS is reserved in PostgreSQL; this fixture relation must be a valid bare identifier.
  assert.match(original, /create temporary table overlap_receipts\(name text,receipt jsonb\);/);
  assert.doesNotMatch(original, /\boverlaps\b/i);
  const lines = original.split(/(?<=\n)/); const take = (a,b) => lines.slice(a-1,b).join('');
  assert.equal(phases.setup, take(1,3) + take(5,60) + take(73,76));
  const ranges = [[79,80,81,86,98],[101,102,103,108,117],[120,121,122,127,140],[142,143,146,149,159],[162,163,164,169,187],[189,190,194,197,202]];
  ranges.forEach(([o,a,c,n,z],i) => {
    assert.equal(phases.races[i].observe, take(o,o));
    assert.equal(phases.races[i].release, take(a,c));
    assert.equal(phases.races[i].after, take(n,z));
  });
  assert.equal(phases.finish,take(205,208));
  const retained = phases.setup + phases.races.map(r => r.observe+r.release+r.after).join('') + phases.finish;
  const expressions = sql => sql.match(/^select (?:is|ok|throws_ok)\([\s\S]*?;\n/gm);
  assert.equal(expressions(original).length,28);
  assert.deepEqual(expressions(retained),expressions(original));
  assert.deepEqual(phases.races.map(r => r.actors.map(a => [a.session,a.operation,a.resultName])), [
    [['a','claim','claim'],['b','claim','claim']], [['a','complete','complete'],['b','legacy','legacy']],
    [['a','attention-a','cas'],['b','attention-b','cas']], [['a','expire','expired']],
    [['a','allocate','allocate'],['b','legacy-high','legacy-high']], [['a','attention-a','stale-evaluator']],
  ]);
  assert(!retained.includes('extensions.dblink')); // Historical explanatory comment is retained byte-for-byte.
});

test('fixed direct client route does not use a shell, password wrapper, TCP or auth changes', () => {
  const args=clientArgs('ovd591-owned',options,true);
  assert.deepEqual(args.slice(-10),['psql','-U','postgres','-d','postgres','-X','-Atq','-w','-v','ON_ERROR_STOP=1']);
  assert(args.includes('ovd591-owned')); assert(!args.includes('sh')); assert(!args.includes('-h'));
  // pg_temp.await_overlap() selects actors by application_name; psql's fallback name
  // overrides PGOPTIONS, so the name must also arrive as PGAPPNAME.
  assert(args.slice(0, args.indexOf('ovd591-owned')).includes('PGAPPNAME=ovd591-race'));
  assert(clientArgs('ovd591-owned',options,false).includes('PGAPPNAME=ovd591-coordinator'));
  assert.throws(()=>clientArgs('production',options,true)); assert.throws(()=>clientArgs('ovd591-owned','-crole=other',true));
});
test('identities, overlap and results reject forged, missing, duplicate or transport-like outcomes', () => {
  acceptIdentity(identity(1));
  for(const patch of [{pid:0},{database:'other'},{sessionUser:'other'},{currentUser:'other'},{serverAddress:'127.0.0.1'},{clientAddress:'127.0.0.1'},{backendStart:'bad'}]) assert.throws(()=>acceptIdentity({...identity(1),...patch}));
  const rows=[2,3].map(pid=>({pid,blockers:[1],waitEvent:'advisory',observedAt:'2026-10-02T00:00:00Z'}));
  acceptOverlap(rows,[2,3],1);
  for(const bad of [[],[rows[0],rows[0]],[{...rows[0],blockers:[99]},rows[1]],[{...rows[0],observedAt:'bad'},rows[1]]]) assert.throws(()=>acceptOverlap(bad,[2,3],1));
  assert.deepEqual(actorResult('{"result":null,"sqlstate":"23505"}\n'),{result:null,sqlstate:'23505'});
  for(const bad of ['', '{}','{}\n{}','{"result":null,"sqlstate":"timeout"}','{"result":null,"sqlstate":null}'])assert.throws(()=>actorResult(bad));
  assert.throws(()=>oneJson('{}\n{}\n'));
});
test('COPY result framing keeps actor data from becoming SQL or a psql command', () => {
  const value={result:{text:"x\n\\.\n\\! touch /tmp/not-permitted\t' ; drop table x;\r"},sqlstate:null};
  const copy=resultCopy([{name:'claim',value}]);
  assert.equal(copy.split('\n').length,4); assert(copy.includes('\\\\.')); assert(!copy.includes('\n\\!'));
  assert.throws(()=>resultCopy([{name:"claim'); select 1;--",value}]));
});

const processSource = `
const readline=require('node:readline'); let mode='';
readline.createInterface({input:process.stdin}).on('line',line=>{
 if(line==='\\\\q'){process.exit(0);return;}
 if(!line.startsWith('\\\\echo ')){if(line)mode=line;return;}
 const marker=line.slice(6);
 if(mode==='hang')return;
 if(mode==='stderr'){process.stderr.write('synthetic failure\\n');return;}
 if(mode==='exit'){process.exit(7);return;}
 if(mode==='oversized'){process.stdout.write('x'.repeat(2000));return;}
 if(mode==='stale'){process.stdout.write('ovd591-frame-stale\\n');return;}
 const output='{"result":{"status":"claimed"},"sqlstate":null}\\n'+marker+'\\n';
 if(mode==='fragmented'){process.stdout.write(output.slice(0,7));setTimeout(()=>process.stdout.write(output.slice(7)),5);}
 else {process.stdout.write(output);if(mode==='duplicate')setTimeout(()=>process.stdout.write(marker+'\\n'),5);}
});`;
function syntheticSession(config={}) { const record={}; const child=spawn(process.execPath,['-e',processSource],{stdio:['pipe','pipe','pipe']}); return new PsqlSession(child,'synthetic',record,{timeoutMs:200,...config}); }
test('real synthetic IPC handles fragmented responses and persistent commands, retaining process receipts', async () => {
  const session=syntheticSession();
  actorResult(await session.request('fragmented')); actorResult(await session.request('normal'));
  await session.close();assert.equal(session.record.exit.code,0);assert.equal(session.record.submissions.length,2);
});
for(const mode of ['stderr','exit','oversized','stale','hang'])test(`real synthetic IPC rejects ${mode} without a business result`,async()=>{
 const session=syntheticSession({limit:1000});
 const expected={stderr:/unexpected stderr/,exit:/failed process exit/,oversized:/output limit/,stale:/foreign acknowledgment/,hang:/phase deadline/};
 await assert.rejects(session.request(mode),expected[mode]);
 await assert.rejects(session.close());session.child.kill('SIGTERM');
});
test('duplicate acknowledgment poisons subsequent work',async()=>{
 const session=syntheticSession();await session.request('duplicate');
 await new Promise(resolve=>setTimeout(resolve,20));await assert.rejects(session.request('normal'));
 await assert.rejects(session.close());session.child.kill('SIGTERM');
});

function fakeTopology({badOverlap=false,actorError=false,remaining=0}={}) {
 const events=[],pending=new Map(), records={};let ready=0,locked=false,current=0;
 const make=(name,record)=>{
  records[name]=record;
  return {record,child:{kill(){events.push('kill:'+name);}},fail(){},async close(){events.push('close:'+name);},
   async request(sql){events.push([name,sql]);
    if(sql===IDENTITY_SQL){ready++;return JSON.stringify(identity({coordinator:1,a:2,b:3}[name]));}
    if(name!=='coordinator'){
     assert(locked,'actors must start behind coordinator lock');
     return new Promise((resolve,reject)=>pending.set(name,{resolve,reject}));
    }
    if(sql===phases.setup){assert.equal(ready,3);locked=true;return '';}
    const race=phases.races[current];
    if(sql===race?.observe){assert.equal(pending.size,race.actors.length);return '';}
    if(sql.startsWith('select receipt'))return JSON.stringify(race.actors.map(a=>({pid:badOverlap?99:{a:2,b:3}[a.session],blockers:[1],waitEvent:'advisory',observedAt:'2026-10-02T00:00:00Z'})));
    if(sql===race?.release){assert(locked);locked=false;for(const p of pending.values())actorError?p.reject(new Error('actor transport failed')):p.resolve('{"result":{"status":"synthetic"},"sqlstate":null}');pending.clear();return '';}
    if(sql.startsWith('copy race_results')){assert(!locked);return '';}
    if(sql===race?.after){current++;locked=current<6;return '';}
    if(sql.startsWith('select count(*)')){assert(events.includes('close:a')&&events.includes('close:b'));return String(remaining);}
    if(sql===phases.finish){assert.equal(current,6);return 'synthetic coordinator output\n';}
    throw Error('unexpected coordinator command');
   }};
 };return {make,events,records};
}
test('orchestration prestarts actors, dispatches concurrently under acknowledged lock, checks overlap before release and closes actors before cleanup',async()=>{
 const t=fakeTopology(),evidence={}; const output=await executePhases(phases,t.make,{evidence});
 assert.equal(output,'synthetic coordinator output\n');assert.equal(evidence.races.length,6);assert.equal(evidence.backendCleanup,'actors-observed-absent');
 for(const race of phases.races){const observed=t.events.findIndex(e=>Array.isArray(e)&&e[1].startsWith(`select receipt from overlap_receipts where name='${race.name}'`));const released=t.events.findIndex(e=>Array.isArray(e)&&e[1]===race.release);assert(observed<released);}
});
test('wrong actor PID overlap aborts before release and cannot finish TAP',async()=>{
 const t=fakeTopology({badOverlap:true});await assert.rejects(executePhases(phases,t.make));
 assert(!t.events.some(e=>Array.isArray(e)&&e[1]===phases.races[0].release));assert(!t.events.some(e=>Array.isArray(e)&&e[1]===phases.finish));
});
test('transport failure is not inserted as a business SQLSTATE',async()=>{
 const t=fakeTopology({actorError:true});await assert.rejects(executePhases(phases,t.make),/actor transport failed/);
 assert(!t.events.some(e=>Array.isArray(e)&&e[1].startsWith('copy race_results')));
});
test('remaining actor backend forbids helper cleanup and successful finish',async()=>{
 const t=fakeTopology({remaining:1});await assert.rejects(executePhases(phases,t.make),/actor backends/);
 assert(!t.events.some(e=>Array.isArray(e)&&e[1]===phases.finish));
});


test('suite deadline fails closed and stops before finish even if a phase never acknowledges',async()=>{
 const t=fakeTopology(), evidence={};
 const make=(name,record)=>{const session=t.make(name,record);const request=session.request.bind(session);
 session.request=sql=>sql===phases.races[0].observe?new Promise(()=>{}):request(sql);return session;};
 await assert.rejects(executePhases(phases,make,{evidence,timeoutMs:20,shutdownMs:20}),/suite deadline/);
 assert(!t.events.some(e=>Array.isArray(e)&&e[1]===phases.finish));
});
test('unconfirmed shutdown remains explicitly unconfirmed rather than claiming backend cleanup',async()=>{
 const t=fakeTopology({badOverlap:true}),evidence={};
 const make=(name,record)=>{const session=t.make(name,record);session.close=()=>new Promise(()=>{});return session;};
 await assert.rejects(executePhases(phases,make,{evidence,shutdownMs:20}));
 assert.equal(evidence.backendCleanup,'unconfirmed');assert(evidence.shutdown.every(v=>v.status==='unconfirmed'));
 assert.equal(t.events.filter(e=>typeof e==='string'&&e.startsWith('kill:')).length,3);
});
test('failed coordinator TAP stops before release or cleanup',async()=>{
 const t=fakeTopology();const make=(name,record)=>{const session=t.make(name,record);const request=session.request.bind(session);
 session.request=sql=>sql===phases.races[0].observe?Promise.resolve('not ok 1 - failed\n'):request(sql);return session;};
 await assert.rejects(executePhases(phases,make),/TAP failure/);
 assert(!t.events.some(e=>Array.isArray(e)&&e[1]===phases.finish));
});
