import type { ThreadClient } from './client';
declare const c: ThreadClient;
void c.resolve('r', 'd', { resolution: 'chosen', choice: 'a', idempotencyKey: 'k' });
void c.resolve('r', 'd', { resolution: 'skipped_best_guess', idempotencyKey: 'k' });
// @ts-expect-error idempotencyKey is required for resolve
void c.resolve('r', 'd', { resolution: 'chosen', choice: 'a' });
// @ts-expect-error unknown resolution rejected
void c.resolve('r', 'd', { resolution: 'other', idempotencyKey: 'k' });
void c.control('r', { kind: 'pause', idempotencyKey: 'k' });
void c.control('r', { kind: 'cancel', idempotencyKey: 'k' });
// @ts-expect-error idempotencyKey is required for control
void c.control('r', { kind: 'pause' });
// @ts-expect-error resume/steer not exposed in the thread client
void c.control('r', { kind: 'resume', idempotencyKey: 'k' });
export {};
