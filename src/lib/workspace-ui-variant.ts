export type WorkspaceUiVariant = "classic" | "northstar";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function isNorthStarEnvEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

export function resolveWorkspaceUiVariant(
  search: string,
  envValue: string | undefined = import.meta.env.VITE_ENABLE_NORTH_STAR_UI,
): WorkspaceUiVariant {
  if (!isNorthStarEnvEnabled(envValue)) {
    return "classic";
  }

  const params = new URLSearchParams(search);
  const requestedVariant = params.get("ui")?.trim().toLowerCase();

  return requestedVariant === "northstar" ? "northstar" : "classic";
}
