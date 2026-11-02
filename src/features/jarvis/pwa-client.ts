export type JarvisPwaClientResult =
  | { readonly kind: "admitted" }
  | { readonly kind: "step_up" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "absent" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function readJarvisPwaSession(response: Response): Promise<JarvisPwaClientResult> {
  if (response.status === 401) return { kind: "signed_out" };
  if (response.status === 403) {
    const body: unknown = await response.json().catch(() => null);
    if (isRecord(body) && Object.keys(body).length === 1 && body.error === "aal2_required") {
      return { kind: "step_up" };
    }
    return { kind: "absent" };
  }
  if (response.status === 200) {
    const body: unknown = await response.json().catch(() => null);
    const thread = isRecord(body) ? body.thread : null;
    if (
      isRecord(body)
      && Object.keys(body).length === 1
      && isRecord(thread)
      && Object.keys(thread).length === 1
      && thread.state === "empty"
    ) {
      return { kind: "admitted" };
    }
  }
  return { kind: "absent" };
}

export async function loadJarvisPwaSession(
  token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<JarvisPwaClientResult> {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetchImpl("/api/jarvis/session", {
    method: "GET",
    headers,
    cache: "no-store",
  });
  return readJarvisPwaSession(response);
}
