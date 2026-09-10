// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec=promisify(execFile);
const runner=path.resolve('scripts/test-engineering-native-results.mjs');
const refusal='Pass one disposable local OVD-498/505 container';

describe('native result test runner admission',()=>{
  it.each([[],['postgres://example.test/database'],['production-db'],['supabase_db_ovd505-']])(
    'rejects unadmitted target %j before Docker',async (...args)=>{
      const result=await exec(process.execPath,[runner,...args],{env:{...process.env,PATH:''}}).catch(error=>error);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(refusal);
      expect(result.stderr).not.toContain('spawn docker');
    });
  it('refuses extra output paths without modifying the destination',async ()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'ovd505-cli-'));
    const destination=path.join(directory,'preserve.json');
    try {
      await writeFile(destination,'preserved fixture');
      const result=await exec(process.execPath,[runner,'supabase_db_ovd505-fixture',destination],
        {env:{...process.env,PATH:directory}}).catch(error=>error);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(refusal);
      expect(result.stderr).not.toContain('spawn docker');
      expect(await readFile(destination,'utf8')).toBe('preserved fixture');
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});
