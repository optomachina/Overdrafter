import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { PostgrestSingleResponse } from "@supabase/supabase-js";

type RpcName = keyof Database["public"]["Functions"];

export const untypedSupabase = supabase as typeof supabase & {
  from: (relation: string) => unknown;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<PostgrestSingleResponse<unknown>>;
};

export function callRpc<Name extends RpcName>(
  fn: Name,
  args: Database["public"]["Functions"][Name]["Args"],
): Promise<PostgrestSingleResponse<Database["public"]["Functions"][Name]["Returns"]>> {
  return untypedSupabase.rpc(fn, args) as unknown as Promise<
    PostgrestSingleResponse<Database["public"]["Functions"][Name]["Returns"]>
  >;
}

export function callUntypedRpc(
  fn: string,
  args?: Record<string, unknown>,
): Promise<PostgrestSingleResponse<unknown>> {
  return untypedSupabase.rpc(fn, args);
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
