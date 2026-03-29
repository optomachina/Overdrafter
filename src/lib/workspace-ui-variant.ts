export type WorkspaceUiVariant = "classic" | "north_star_preview";

export interface WorkspaceUiVariantInput {
  envEnableNorthStarUi?: string | null;
  urlSearch?: string | URLSearchParams | null;
  isInternalUser: boolean;
}

function parseEnabledFlag(raw: string | null | undefined): boolean {
  if (!raw) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseNorthStarPreviewParam(search: string | URLSearchParams | null | undefined): boolean {
  if (!search) {
    return false;
  }

  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search;

  return params.get("north_star_ui") === "1";
}

export function resolveWorkspaceUiVariant({
  envEnableNorthStarUi,
  urlSearch,
  isInternalUser,
}: WorkspaceUiVariantInput): WorkspaceUiVariant {
  if (isInternalUser) {
    return "classic";
  }

  if (!parseEnabledFlag(envEnableNorthStarUi)) {
    return "classic";
  }

  if (!parseNorthStarPreviewParam(urlSearch)) {
    return "classic";
  }

  return "north_star_preview";
}
