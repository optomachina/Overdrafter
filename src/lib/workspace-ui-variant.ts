export type WorkspaceUiVariant = "classic" | "north_star_preview";

export type WorkspaceUiRole = "client" | "internal_admin" | "internal_estimator" | null;

export interface ResolveWorkspaceUiVariantOptions {
  role: WorkspaceUiRole;
  enableNorthStarUiEnv?: string;
  search?: string;
}

function isNorthStarEnvEnabled(value?: string): boolean {
  if (!value) {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function isNorthStarQueryEnabled(search = ""): boolean {
  const params = new URLSearchParams(search);
  return params.get("north_star_ui") === "1";
}

export function resolveWorkspaceUiVariant(options: ResolveWorkspaceUiVariantOptions): WorkspaceUiVariant {
  const { role, enableNorthStarUiEnv, search } = options;

  if (role === "internal_admin" || role === "internal_estimator") {
    return "classic";
  }

  const envEnabled = isNorthStarEnvEnabled(enableNorthStarUiEnv);
  const queryEnabled = isNorthStarQueryEnabled(search);

  if (envEnabled && queryEnabled) {
    return "north_star_preview";
  }

  return "classic";
}
