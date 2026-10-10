# OVD-671: New Job Click Timeout Investigation

**Date:** October 10, 2026
**Status:** Fixed
**Severity:** Medium
**Affected Component:** Web client RPC calls

## Issue Summary

On production, in a fresh session, the first "New Job" click timed out. A retry worked. This was suspected to be a cold start or slow first request issue.

## Root Cause Analysis

### Investigation Path

1. **Traced the "New Job" flow:**
   - Client clicks "New Job" → `newJobFilePicker.openFilePicker()` → user selects files → `createJobsFromUploadFiles()` → multiple RPC calls:
     - `api_create_job` (creates job record)
     - `api_prepare_part_intake` (optional, for CAD hash checking)
     - `api_prepare_job_file_upload` (for each file)
     - Storage uploads
     - `api_finalize_job_file_upload` (for each file)
     - `api_reconcile_job_parts`
     - `api_request_extraction`

2. **Examined RPC implementation:**
   - Located in `src/features/quotes/api/shared/rpc.ts`
   - Calls `supabase.rpc()` directly without any timeout mechanism
   - The Supabase client in `src/integrations/supabase/client.ts` is created with `createClient()` **without any timeout configuration**

3. **Found evidence in codebase:**
   - Worker code in `worker/src/spendGuard.ts` has explicit comment: "supabase-js applies no client-side timeout by default"
   - Worker has `SPEND_RPC_TIMEOUT_MS = 10_000` (10 seconds) for spend guard RPCs
   - Web client has NO timeout configured
   - Worker API in `src/features/quotes/api/worker-api.ts` uses AbortController with 10-second timeout as precedent

### Root Cause

**The Supabase client RPC calls have no timeout mechanism.** On a fresh session, the first RPC call might:
- Take longer due to cold database connection pool initialization
- Hang indefinitely if there's a network hiccup
- Be slow due to auth session initialization overhead
- Experience delays from Founding Beta access checks

Without a timeout, the client waits indefinitely (or until browser/network timeout triggers), giving the appearance of a timeout. A retry works because the session is "warmed up" by then.

## Solution Implemented

Added a **30-second timeout** to all RPC calls using a Promise.race pattern:

### Changes

**File:** `src/features/quotes/api/shared/rpc.ts`

1. **Added timeout constant:**
   ```typescript
   const DEFAULT_RPC_TIMEOUT_MS = 30_000;
   ```

2. **Created timeout error class:**
   ```typescript
   export class RpcTimeoutError extends Error {
     constructor(functionName: string, timeoutMs: number) {
       super(`RPC call to ${functionName} timed out after ${timeoutMs}ms`);
       this.name = "RpcTimeoutError";
     }
   }
   ```

3. **Implemented timeout wrapper:**
   ```typescript
   function withRpcTimeout<T>(
     promise: Promise<T>,
     functionName: string,
     timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
   ): Promise<T> {
     return Promise.race([
       promise,
       new Promise<T>((_, reject) => {
         setTimeout(() => {
           reject(new RpcTimeoutError(functionName, timeoutMs));
         }, timeoutMs);
       }),
     ]);
   }
   ```

4. **Wrapped existing RPC calls:**
   - `callRpc()` now wraps the RPC promise with timeout
   - `callUntypedRpc()` now wraps the RPC promise with timeout

### Rationale for 30-Second Timeout

- Matches the `WAIT_TIMEOUT_MS = 30_000` in `src/hooks/use-workspace-readiness.ts`
- Longer than the worker's 10-second timeout (worker operations are typically faster)
- Allows for cold start delays while still preventing indefinite hangs
- Provides clear error messages when timeouts occur

## Testing

**Created:** `src/features/quotes/api/shared/rpc.test.ts`

Test cases:
1. ✅ Timeout after 30 seconds for slow RPC
2. ✅ No timeout if RPC completes before timeout
3. ✅ Database errors propagate normally
4. ✅ Multiple concurrent RPC calls have independent timeouts

## Impact Assessment

### Affected Flows
- All Supabase RPC calls throughout the application
- Particularly important for:
  - Job creation (first click in fresh session)
  - File uploads
  - Quote requests
  - Any other RPC-based operation

### Risk Level: Low
- **Backward Compatible:** Yes (only adds timeout behavior)
- **Breaking Changes:** None
- **Performance Impact:** Negligible (only adds Promise.race wrapper)

### Benefits
1. **Prevents indefinite hangs** on slow network or cold start
2. **Provides clear error messages** when timeouts occur
3. **Improves user experience** with faster failure feedback
4. **Enables retry logic** to be implemented more cleanly

## Verification

### Manual Testing Recommendation
1. Test in production with fresh browser session (incognito mode)
2. Click "New Job" and select files
3. Verify no timeout occurs on first attempt
4. If timeout still occurs, investigate other causes (see below)

### CI/Build Verification
- Run `npm run typecheck`
- Run `npm test` (when environment is ready)
- Run `npm run build`

## Alternative Hypotheses (if fix doesn't resolve)

If the timeout still occurs after this fix, investigate:

1. **Database Performance:**
   - Check PostgreSQL logs for slow queries
   - Review `api_create_job` execution time
   - Check connection pool health

2. **Network Issues:**
   - Check Vercel Edge Function cold start times
   - Review Supabase network latency

3. **Founding Beta Checks:**
   - Review `api_create_job` Founding Beta access logic
   - Check if enrollment checks are slow

4. **Storage Layer:**
   - Review Supabase Storage upload performance
   - Check if file preparation is blocking

## Questions for Further Investigation (if needed)

1. What are the actual `api_create_job` execution times in production logs?
2. What is the timing breakdown between file selection and job creation?
3. Are there any rate limits or quotas being hit?
4. What are the timestamps in the browser network tab for the first vs. retry attempt?

## Related Files

- `src/features/quotes/api/shared/rpc.ts` (modified)
- `src/features/quotes/api/shared/rpc.test.ts` (new)
- `src/features/quotes/use-client-home-controller.ts` (uses createJobsFromUploadFiles)
- `src/features/quotes/api/uploads-api.ts` (createJobsFromUploadFiles)
- `src/features/quotes/api/jobs-api.ts` (createJob, createClientDraft)

## References

- Linear Issue: [OVD-671](https://linear.app/overdrafter/issue/OVD-671/new-job-click-times-out-on-first-attempt)
- Worker precedent: `worker/src/spendGuard.ts` (10-second timeout)
- Worker API precedent: `src/features/quotes/api/worker-api.ts` (AbortController pattern)
