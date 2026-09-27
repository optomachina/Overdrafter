/** Real HTTP repository/handler -> fixture PostgREST -> migrated PostgreSQL proof.
 * Called only with the exclusive disposable runner's resource handles. */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const n = value => `50100000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function section(source, name) {
  const begin = `-- OVD576_RACE_${name}_BEGIN`, end = `-- OVD576_RACE_${name}_END`;
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  return source.split(begin)[1].split(end)[0];
}
/** Synthetic role membership and credentials exist only inside this owned DB. */
export async function runNativeStopHttpProof({ call, psql, network, container, fixtureId, output, root, prefix, test, dockerExecutable }) {
  const image = 'public.ecr.aws/supabase/postgrest:v14.5';
  const imageId = call(['image', 'inspect', image, '--format', '{{.Id}}']).stdout.trim();
  const workerToken = `odw_${randomBytes(32).toString('hex')}`;
  const workerHash = createHash('sha256').update(workerToken).digest('hex');
  const password = randomBytes(24).toString('hex'), jwtSecret = randomBytes(32).toString('hex');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ role: 'ovd576_stop_validator', exp: Math.floor(Date.now()/1000)+900 })).toString('base64url');
  const unsigned = `${header}.${body}`;
  const signature = createHmac('sha256', jwtSecret).update(unsigned).digest('base64url');
  const token = `${unsigned}.${signature}`;
  const digestSource = "select encode(extensions.digest('synthetic-ovd501-'||n::text,'sha256'),'hex');";
  assert.equal(prefix.split(digestSource).length, 2, 'fixture credential helper identity');
  const seededPrefix = prefix.replace(digestSource,
    `select case when n=9 then ${quote(workerHash)} else encode(extensions.digest('synthetic-ovd501-'||n::text,'sha256'),'hex') end;`);
  psql(`${seededPrefix}\n${section(test, 'SEED')}\n`+
    `create role ovd577_fixture_gateway login noinherit password ${quote(password)};\n`+
    'grant ovd576_stop_validator to ovd577_fixture_gateway;\ncommit;', 240_000);
  const task = psql(`select t.id from public.engineering_tasks t join public.engineering_decisions d on d.id=t.decision_id
    where t.conversation_id=${quote(n(30))} and d.sequence=1`);
  const attempt = psql(`select current_attempt_id from public.engineering_task_execution where task_id=${quote(task)}`);
  const request = { schema: 'overdrafter.native-stop-request.v1', action: 'record_stop', workerId: n(50), bootId: n(52),
    taskId: task, attemptId: attempt, fence: 1, evidenceId: n(91), revision: 1, idempotencyKey: n(220) };
  const name = `ovd577-http-${fixtureId.slice(0,8)}`; let created = false;
  // The handler uses Web Request/Response in Deno; the adapter makes real HTTP
  // requests inside the private Docker network. The fetch-to-Docker bridge and
  // TLS termination are simulated; request bytes/status and SQL effects are real.
  const program = String.raw`import { createWorkerStopHandler } from ${JSON.stringify(new URL('../supabase/functions/engineering-worker-stop/index.ts', import.meta.url).href)};
import { createNativeStopRepository } from ${JSON.stringify(new URL('../server/engineering/native-stop-repository.ts', import.meta.url).href)};
const config = JSON.parse(await new Response(Deno.stdin.readable).text());
let dispatched=0;
const repository=()=>createNativeStopRepository({url:'https://fixture.invalid',token:config.token,
 fetch:async (url,init)=>{dispatched++;
 const headers=new Headers(init.headers), args=['exec','-i',config.container,'curl','--silent','--show-error','--max-time','5',
 '--request','POST','--data-binary','@-','--write-out','\n%{http_code}'];
 for(const [key,value] of headers)args.push('--header',key+': '+value);
 args.push(String(url).replace('https://fixture.invalid',config.origin));
 const child=new Deno.Command(config.dockerExecutable,{args,stdin:'piped',stdout:'piped',stderr:'piped'}).spawn();
 const writer=child.stdin.getWriter();await writer.write(new TextEncoder().encode(init.body));await writer.close();
 const output=await child.output();if(!output.success)throw new TypeError('fixture HTTP bridge failed');
 const text=new TextDecoder().decode(output.stdout),split=text.lastIndexOf('\n');
 const response=new Response(text.slice(0,split),{status:Number(text.slice(split+1))});
 if(config.loseResponse && response.ok){await response.body?.cancel();throw new TypeError('synthetic lost response');}return response;}});
const handler=createWorkerStopHandler({enabled:()=>config.enabled,repository});
const input=new Request('https://fixture.invalid/functions/v1/engineering-worker-stop',{method:'POST',
headers:{authorization:'Bearer '+config.workerToken,'content-type':'application/json'},body:JSON.stringify(config.request)});
const result=await handler(input);console.log(JSON.stringify({status:result.status,body:await result.json(),dispatched}));`;
  const programPath = join(output, 'stop-edge-proof.ts'); writeFileSync(programPath, program);
  let checks = 0;
  const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
  const snapshot = () => psql(`select jsonb_build_object(
    'attempt',(select to_jsonb(a) from public.engineering_execution_attempts a where id=${quote(attempt)}),
    'slots',(select jsonb_agg(to_jsonb(s) order by s.organization_id) from engineering_private.native_slots s),
    'events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb) from engineering_private.native_attempt_events e where e.attempt_id=${quote(attempt)}),
    'admissions',(select count(*) from engineering_private.native_stop_admissions))`);
  try {
    call(['run','--detach','--name',name,'--label',`overdrafter.fixture-id=${fixtureId}`,'--network',network,
      '--cpus','0.5','--memory','256m','--pids-limit','128','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
      '--tmpfs','/tmp:rw,nosuid,noexec,size=16m',
      '-e',`PGRST_DB_URI=postgres://ovd577_fixture_gateway:${password}@${container}:5432/postgres`,
      '-e','PGRST_DB_SCHEMAS=engineering_private','-e',`PGRST_JWT_SECRET=${jwtSecret}`,image]); created=true;
    // Docker Desktop does not publish ports on this internal network. Keep
    // isolation intact and probe from the owned DB container instead.
    const origin=`http://${name}:3000`;
    let ready=false;
    for(let i=0;i<60;i++) {
      const probe=call(['exec',container,'curl','--silent','--output','/dev/null','--write-out','%{http_code}',origin],{allowFailure:true});
      if(probe.status===0 && probe.stdout.trim()==='401'){ready=true;break;}
      await delay(100);
    }
    if(!ready) {
      const logs=call(['logs','--tail','40',name],{allowFailure:true});
      const sanitized=(logs.stdout+logs.stderr).replaceAll(password,'[fixture-password]').replaceAll(jwtSecret,'[fixture-jwt-secret]').replaceAll(token,'[fixture-token]');
      writeFileSync(join(output,'postgrest-startup.txt'),sanitized);
      throw new Error('fixture_postgrest_readiness_failed');
    }
    const invoke = (patch={}, options={}) => {
      const run=spawnSync('/opt/homebrew/bin/deno',['run','--no-config','--no-lock',`--allow-run=${dockerExecutable}`,programPath],
        {cwd:root,encoding:'utf8',timeout:15000,input:JSON.stringify({origin,token,workerToken,dockerExecutable,container,request:{...request,...patch},enabled:true,...options})});
      assert.equal(run.status,0,run.stderr); return JSON.parse(run.stdout.trim());
    };
    const before=snapshot();
    check(invoke({}, {enabled:false}).dispatched,0,'disabled has zero executor calls');
    check(invoke({verdict:'all_owned_processes_exited'}).status,400,'worker verdict rejected');
    check(invoke({}, {workerToken:`odw_${'0'.repeat(64)}`}).status,401,'wrong paired credential');
    check(invoke({bootId:n(999)}).status,401,'foreign boot');
    check(invoke({attemptId:n(999)}).status,401,'foreign attempt');
    check(invoke({fence:2}).status,409,'wrong fence');
    check(invoke({evidenceId:n(999)}).status,409,'unknown evidence');
    check(invoke().status,409,'unqualified evidence');
    check(snapshot(),before,'all denials preserve revisions occupancy and history');
    // Exact immutable qualification is a synthetic fixture-owner operation.
    // pg_temp helpers from the seed connection are intentionally not reused.
    const qualification=section(test,'QUAL').replaceAll('pg_temp.n(91)',quote(n(91))).replaceAll('pg_temp.n(1)',quote(n(1)))
      .replaceAll('pg_temp.h(93)',quote(createHash('sha256').update('synthetic-ovd501-93').digest('hex')));
    psql(qualification);
    check(invoke({revision:0}).status,409,'stale revision');
    const lost=invoke({}, {loseResponse:true});
    check(lost.status,503,'lost committed response'); check(lost.body.retrySameRequest,true,'ambiguous same-key retry');
    check(lost.body.outcome,'unknown','does not claim rollback');
    const replay=invoke(); check(replay.status,200,'exact retry succeeds');
    check(replay.body.receipt.verification,'unverified','release is not result verification');
    const committed=psql(`select receipt from engineering_private.native_attempt_events where attempt_id=${quote(attempt)} and kind='stopped'`);
    check(replay.body.receipt,JSON.parse(committed),'returns original committed receipt');
    const after=snapshot();
    check(invoke({fence:2}).status,409,'changed-fence replay denied');
    check(invoke({idempotencyKey:n(221)}).status,409,'new key after commit denied');
    check(snapshot(),after,'replays do not mutate');
    check(psql(`select active_attempt_id is null from engineering_private.native_slots where organization_id=${quote(n(4))}`),'t','exact occupancy released');
    check(psql(`select count(*) from engineering_private.native_stop_admissions where attempt_id=${quote(attempt)}`),'1','one admission');
    const sourceFiles=['server/engineering/native-stop-admission.ts','server/engineering/native-stop-repository.ts',
      'server/engineering/native-stop-transport.ts','supabase/functions/engineering-worker-stop/index.ts',
      'scripts/ovd577-stop-http-proof.mjs'];
    const sourceSha256=Object.fromEntries(sourceFiles.map(path=>[path,createHash('sha256').update(readFileSync(join(root,path))).digest('hex')]));
    return {checks,sourceSha256,postgrestImage:image,postgrestImageId:imageId,fixtureOnly:true,actualNativeQualification:false,
      boundary:'Deno Edge handler -> production repository -> HTTP PostgREST -> restricted checked SQL',
      simulated:'fetch-to-Docker bridge, TLS termination and owner-qualified immutable observation; no live observer/native claim',disposableCredentials:true};
  } finally {
    if(created) {
      const owner=call(['inspect','--format','{{ index .Config.Labels "overdrafter.fixture-id" }}',name],{allowAfterDeadline:true}).stdout.trim();
      assert.equal(owner,fixtureId,'HTTP fixture cleanup ownership');
      call(['rm','--force',name],{allowAfterDeadline:true});
    }
  }
}
