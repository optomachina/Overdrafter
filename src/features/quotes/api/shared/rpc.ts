import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { PostgrestSingleResponse } from "@supabase/supabase-js";

type RpcName = keyof Database["public"]["Functions"];

export const untypedSupabase = supabase as typeof supabase & {
  from: (relation: string) => unknown;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<PostgrestSingleResponse<unknown>>;
};

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export class RpcTimeoutError extends Error {
  constructor(
    functionName: string,
    timeoutMs: number,
  ) {
    super(`RPC call to ${functionName} timed out after ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

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

export function callRpc<Name extends RpcName>(
  fn: Name,
  ...args: Database["public"]["Functions"][Name]["Args"] extends never
    ? []
    : [args: Database["public"]["Functions"][Name]["Args"]]
): Promise<PostgrestSingleResponse<Database["public"]["Functions"][Name]["Returns"]>> {
  const rpcArgs = args.length > 0 ? args[0] : undefined;
  const rpcPromise = untypedSupabase.rpc(fn, rpcArgs) as unknown as Promise<
    PostgrestSingleResponse<Database["public"]["Functions"][Name]["Returns"]>
  >;
  return withRpcTimeout(rpcPromise, fn as string);
}

export function callUntypedRpc(
  fn: string,
  args?: Record<string, unknown>,
): Promise<PostgrestSingleResponse<unknown>> {
  return withRpcTimeout(untypedSupabase.rpc(fn, args), fn);
}

export function upsertUntyped(
  relation: string,
  values: Record<string, unknown>,
  options?: { onConflict?: string; ignoreDuplicates?: boolean },
): Promise<{ error: unknown }> {
  return (
    untypedSupabase.from(relation) as unknown as {
      upsert: (
        nextValues: Record<string, unknown>,
        nextOptions?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) => Promise<{ error: unknown }>;
    }
  ).upsert(values, options);
}

export function insertUntyped(
  relation: string,
  values: Record<string, unknown>,
): {
  select: (columns: string) => {
    single: () => Promise<PostgrestSingleResponse<unknown>>;
  };
} {
  return (
    untypedSupabase.from(relation) as unknown as {
      insert: (nextValues: Record<string, unknown>) => {
        select: (columns: string) => {
          single: () => Promise<PostgrestSingleResponse<unknown>>;
        };
      };
    }
  ).insert(values);
}
