// @vitest-environment node
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('authenticated Supabase client inference', () => {
  it('retains generated relationships, nullability and invalid-query errors without executing a client', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ovd-client-inference-'));
    try {
      const consumer = path.join(directory, 'consumer.ts');
      await writeFile(consumer, `import type { QueryData } from ${JSON.stringify(path.join(root, 'node_modules/@supabase/supabase-js'))};
declare const client: typeof import(${JSON.stringify(path.join(root, 'src/integrations/supabase/client'))}).supabase;
// These query expressions are compiler input only. This module is never evaluated.
const flat = client.from('jobs').select('id');
const decisions = client.from('engineering_tasks').select('id,engineering_decisions!inner(sequence)');
const memberships = client.from('organization_memberships').select('id,organization_id,role,organizations(id,name,slug)');
const attempts = client.from('engineering_tasks').select('id,execution_state,verification_state,adoption_state,engineering_decisions!inner(sequence),task_execution:engineering_task_execution!engineering_task_execution_task_id_conversation_id_organiz_fkey(task_id,conversation_id,organization_id,project_id,owner_user_id,current_attempt_id,current_attempt:engineering_execution_attempts!engineering_task_execution_current_attempt_id_task_id_fkey(id,task_id,conversation_id,organization_id,project_id,owner_user_id,phase))');
type Flat = QueryData<typeof flat>;
type Decisions = QueryData<typeof decisions>;
type Memberships = QueryData<typeof memberships>;
type Attempts = QueryData<typeof attempts>;
type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type NotNever<T> = [T] extends [never] ? false : true;
// never[] and any[] must not make a broken inference look assignable to valid rows.
export type ValidRows = [
  Assert<NotAny<Flat[number]>>, Assert<NotNever<Flat[number]>>,
  Assert<NotAny<Decisions[number]>>, Assert<NotNever<Decisions[number]>>,
  Assert<NotAny<Memberships[number]>>, Assert<NotNever<Memberships[number]>>,
  Assert<NotAny<Attempts[number]>>, Assert<NotNever<Attempts[number]>>
];
declare const flatRows: Flat;
declare const decisionRows: Decisions;
declare const membershipRows: Memberships;
declare const attemptRows: Attempts;
export const flatShape: { id: string }[] = flatRows;
export const decisionShape: { id: string; engineering_decisions: { sequence: number } }[] = decisionRows;
export const membershipShape: { id: string; organization_id: string; role: string; organizations: { id: string; name: string; slug: string } | null }[] = membershipRows;
type Scope = { task_id: string; conversation_id: string; organization_id: string; project_id: string; owner_user_id: string };
type Attempt = Scope & { id: string; phase: string };
type Execution = Scope & { current_attempt_id: string | null; current_attempt: Attempt | null };
export const attemptShape: { id: string; execution_state: string; verification_state: string; adoption_state: string; engineering_decisions: { sequence: number }; task_execution: Execution[] }[] = attemptRows;
type Current = Attempts[number]['task_execution'][number];
export const nullPointer: Current['current_attempt_id'] = null;
export const nullAttempt: Current['current_attempt'] = null;
// @ts-expect-error The reverse execution relation is a collection, not a single object.
export const wrongExecution: Attempts[number]['task_execution'] = {};
// @ts-expect-error The current-attempt relation is an object or null, never an array.
export const wrongAttempt: Current['current_attempt'] = [];
declare const maybeAttempt: Current['current_attempt'];
// @ts-expect-error A consumer must handle the absent current attempt.
export const unsafePhase: string = maybeAttempt.phase;
// @ts-expect-error A flat UUID field cannot become a number or any.
export const wrongId: number = flatRows[0].id;
// @ts-expect-error The decision sequence cannot become text or any.
export const wrongSequence: string = decisionRows[0].engineering_decisions.sequence;
const invalidColumn = client.from('jobs').select('id,not_a_real_column');
const invalidRelation = client.from('engineering_tasks').select('id,not_a_real_relation(id)');
type BadColumn = QueryData<typeof invalidColumn>;
type BadRelation = QueryData<typeof invalidRelation>;
// Embedded-resource failures live on the requested field; valid sibling fields survive.
type RelationError = BadRelation[number]['not_a_real_relation'];
export type InvalidRowsAreErrors = [
  Assert<NotAny<BadColumn[number]>>, Assert<NotNever<BadColumn[number]>>,
  Assert<NotAny<BadRelation[number]>>, Assert<NotNever<BadRelation[number]>>,
  Assert<NotAny<RelationError>>, Assert<NotNever<RelationError>>,
  Assert<BadColumn[number] extends { error: true } ? true : false>,
  Assert<RelationError extends { error: true } ? true : false>
];
declare const badColumnRows: BadColumn;
declare const badRelationRows: BadRelation;
// @ts-expect-error Invalid fields must not produce a valid row projection.
export const invalidColumnShape: { id: string }[] = badColumnRows;
// @ts-expect-error Unknown relations must not produce the requested related rows.
export const invalidRelationShape: { id: string; not_a_real_relation: { id: string }[] }[] = badRelationRows;
`);
      const configPath = path.join(root, 'tsconfig.app.json');
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      expect(config.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
      expect(parsed.errors).toEqual([]);
      const program = ts.createProgram([consumer, path.join(root, 'src/vite-env.d.ts')], {
        ...parsed.options, noEmit: true, strictNullChecks: true,
      });
      expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
        code: diagnostic.code,
        line: diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
          : undefined,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      }))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
