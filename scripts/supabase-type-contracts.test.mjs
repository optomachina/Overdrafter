// @vitest-environment node
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applyEngineeringRpcNullability } from './supabase-type-contracts.mjs';

describe('engineering RPC nullability', () => {
  it('lets a strict consumer submit clarification and numeric depth without weakening other arguments', async () => {
    const generated = await readFile('src/integrations/supabase/types.ts','utf8');
    const directory = await mkdtemp(path.join(tmpdir(),'ovd497-types-'));
    try {
      await writeFile(path.join(directory,'database.ts'),generated);
      expect(applyEngineeringRpcNullability(generated)).toBe(generated);
      const consumer = path.join(directory,'consumer.ts');
      await writeFile(consumer, `import type { Database } from './database';
type Args = Database['public']['Functions']['api_resolve_engineering_request']['Args'];
const clarification: Args = {p_request_id:'r',p_expected_revision:0,p_idempotency_key:'k',p_outcome:'needs_context',p_depth_mm:null,p_response:'Which depth?',p_provenance:{}};
const change: Args = {...clarification,p_outcome:'prepared_change',p_depth_mm:8};
// @ts-expect-error Depth never accepts text.
const wrongDepth: Args = {...change,p_depth_mm:'8'};
type Control = Database['public']['Functions']['api_control_worker_session']['Args'];
const revoke: Control = {p_worker_id:'w',p_expected_revision:0,p_key:'k',p_action:'revoked',p_boot_id:null};
const enable: Control = {...revoke,p_action:'enabled',p_boot_id:'boot'};
// @ts-expect-error Boot identity never accepts a number.
const wrongBoot: Control = {...enable,p_boot_id:123};
// @ts-expect-error Other numeric fields remain non-null.
const wrongRevision: Args = {...change,p_expected_revision:null};
`);
      const program = ts.createProgram([consumer],{strict:true,noEmit:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[]});
      expect(ts.getPreEmitDiagnostics(program).map((d)=>ts.flattenDiagnosticMessageText(d.messageText,'\n'))).toEqual([]);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('fails visibly when the known function changes shape and leaves older schemas alone', () => {
    expect(applyEngineeringRpcNullability('type OlderDatabase = {}')).toBe('type OlderDatabase = {}');
    expect(()=>applyEngineeringRpcNullability('      api_resolve_engineering_request: {')).toThrow('argument boundary');
    expect(()=>applyEngineeringRpcNullability('      api_resolve_engineering_request: {\n        Args: { p_depth_mm: string }\n        Returns: string')).toThrow('nullable argument');
  });
});
