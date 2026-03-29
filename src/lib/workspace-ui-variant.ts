export type WorkspaceUiVariant = "classic" | "north_star_preview";

export interface ResolveWorkspaceUiVariantInput {
  role: string | null | undefined;
  searchParams: URLSearchParams;
  enableNorthStarUiEnv: string | null | undefined;
}

function isEnabledFlag(value: string | null | undefined): boolean {
  return value === "1";
}

export function resolveWorkspaceUiVariant(input: ResolveWorkspaceUiVariantInput): WorkspaceUiVariant {
  const role = input.role ?? null;

  if (role === "internal_admin" || role === "internal_estimator") {
    return "classic";
  }

  const isEnvEnabled = isEnabledFlag(input.enableNorthStarUiEnv);
  const isPreviewRequested = input.searchParams.get("north_star_ui") === "1";

  if (isEnvEnabled && isPreviewRequested) {
    return "north_star_preview";
  }

  return "classic";
}
