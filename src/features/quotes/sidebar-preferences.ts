const PROJECT_PIN_FALLBACK_PREFIX = "workspace-sidebar-project-pins-v1";

function getProjectPinFallbackKey(userId: string): string {
  return `${PROJECT_PIN_FALLBACK_PREFIX}:${userId}`;
}

function readStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function writeStringArray(key: string, values: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(values));
  } catch {
    // Ignore storage failures; callers should degrade gracefully.
  }
}

export function readLocalPinnedProjectIds(userId: string): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    return readStringArray(window.localStorage.getItem(getProjectPinFallbackKey(userId)));
  } catch {
    return [];
  }
}

export function pinProjectLocally(userId: string, projectId: string): string[] {
  const next = readLocalPinnedProjectIds(userId);

  if (!next.includes(projectId)) {
    next.unshift(projectId);
    writeStringArray(getProjectPinFallbackKey(userId), next);
  }

  return next;
}

export function unpinProjectLocally(userId: string, projectId: string): string[] {
  const next = readLocalPinnedProjectIds(userId).filter((value) => value !== projectId);
  writeStringArray(getProjectPinFallbackKey(userId), next);
  return next;
}
