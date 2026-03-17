export type EdgeFunctionDebugInfo = {
  supabaseOrigin: string | null;
  supabaseProjectRef: string | null;
  functionName: string;
  functionPath: string;
  functionUrl: string | null;
};

function deriveSupabaseProjectRef(hostname: string): string | null {
  const normalizedHostname = hostname.trim().toLowerCase();

  if (!normalizedHostname.includes(".supabase.")) {
    return null;
  }

  const [subdomain] = normalizedHostname.split(".");
  return subdomain || null;
}

export function getEdgeFunctionDebugInfo(
  functionName: string,
  supabaseUrl = import.meta.env.VITE_SUPABASE_URL,
): EdgeFunctionDebugInfo {
  const functionPath = `/functions/v1/${functionName}`;

  if (!supabaseUrl) {
    return {
      supabaseOrigin: null,
      supabaseProjectRef: null,
      functionName,
      functionPath,
      functionUrl: null,
    };
  }

  try {
    const parsedUrl = new URL(supabaseUrl);

    return {
      supabaseOrigin: parsedUrl.origin,
      supabaseProjectRef: deriveSupabaseProjectRef(parsedUrl.hostname),
      functionName,
      functionPath,
      functionUrl: `${parsedUrl.origin}${functionPath}`,
    };
  } catch {
    return {
      supabaseOrigin: null,
      supabaseProjectRef: null,
      functionName,
      functionPath,
      functionUrl: null,
    };
  }
}
