import type { PostgrestResponse, PostgrestSingleResponse } from "@supabase/supabase-js";

export function ensureData<T>(data: T | null, error: { message: string } | null | undefined): T {
  if (error) {
    throw error;
  }

  if (data === null) {
    throw new Error("Expected data but query returned null.");
  }

  return data;
}

export function ensureOptionalRows<T>(
  data: T[] | null,
  error: { message: string } | null | undefined,
  isMissingSchemaError: (value: { message: string } | null | undefined) => boolean,
): T[] {
  if (isMissingSchemaError(error)) {
    return [];
  }

  return ensureData(data, error) as T[];
}

export function emptyResponse<T>(): Promise<PostgrestResponse<T>> {
  return Promise.resolve({
    data: [],
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  });
}

export function emptySingleResponse<T>(data: T | null = null): Promise<PostgrestSingleResponse<T>> {
  return Promise.resolve({
    data,
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  });
}
