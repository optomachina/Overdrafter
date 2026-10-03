import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { acceptTap, acceptContainer, IMAGE, FIXTURE_PASSWORD_SESSION } from './ovd591-sql-qualification.mjs';
test('fixture-only password delivery preserves arbitrary bytes without shell evaluation or argv injection', () => {
  const password = 'synthetic space \' " \\ $HOME $(exit 99)\n\t+/=unicode-é';
  const child = spawnSync('sh', ['-c', FIXTURE_PASSWORD_SESSION, 'fixture-test', process.execPath,
    '-e', 'process.stdout.write(process.env.PGOPTIONS)'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PGOPTIONS: '-ctimezone=UTC', POSTGRES_PASSWORD: password },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout, `-ctimezone=UTC -covd591.fixture_password_b64=${Buffer.from(password).toString('base64')}`);
  assert(!FIXTURE_PASSWORD_SESSION.includes(password));
});
test('missing fixture password stops before executing the supplied command', () => {
  const child = spawnSync('sh', ['-c', FIXTURE_PASSWORD_SESSION, 'fixture-test', 'echo', 'must not execute'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, PGOPTIONS: '-ctimezone=UTC' },
  });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'fixture password missing\n');
});
test('SQL output requires complete unskipped passing TAP, not process exit alone', () => {
  assert.equal(acceptTap('1..2\nok 1 - a\nok 2 - b\n'), 2);
  for (const output of ['', '1..0 # SKIP unavailable', '1..2\nok 1', '1..1\nnot ok 1',
    '1..1\nok 1 # TODO', '1..1\nok 1 # SKIP', '1..1\nok 2', '1..1\nok 1\nBail out!',
    '1..1\nok 1\n1..1']) assert.throws(() => acceptTap(output));
});
test('fixture targeting rejects foreign source, exposed, mounted, stopped or privileged container', () => {
  const info = {Name:'/ovd591-test',Config:{Image:IMAGE,Labels:{'ovd591.owner':'ovd591-disposable','ovd591.source':'abc'}},
    State:{Running:true},HostConfig:{NanoCpus:2_000_000_000,Memory:3*1024**3,PidsLimit:256,Privileged:false,NetworkMode:'ovd591-test',PortBindings:{}},Mounts:[]};
  acceptContainer(info,'abc');
  const bad = [v=>v.Config.Labels['ovd591.source']='other',v=>v.Config.Labels['ovd591.owner']='other',
    v=>v.Config.Image='postgres:latest',v=>v.Name='/production',v=>v.State.Running=false,
    v=>v.HostConfig.Memory=0,v=>v.HostConfig.NanoCpus=0,v=>v.HostConfig.PidsLimit=-1,v=>v.HostConfig.Privileged=true,v=>v.HostConfig.NetworkMode='host',
    v=>v.HostConfig.PortBindings={'5432/tcp':[]},v=>v.Mounts=[{Type:'bind'}]];
  for(const mutate of bad){const v=structuredClone(info);mutate(v);assert.throws(()=>acceptContainer(v,'abc'));}
});
