import type { ProjectAssigneeProfile } from "@/features/quotes/types";

export type ProjectAssigneeBadgeModel = {
  displayName: string;
  initials: string | null;
  colorClassName: string | null;
  isUnassigned: boolean;
};

const ASSIGNEE_BUBBLE_COLORS = [
  "border-border bg-card text-sky-800 dark:text-foreground",
  "border-border bg-card text-emerald-800 dark:text-foreground",
  "border-border bg-card text-amber-800 dark:text-foreground",
  "border-border bg-card text-rose-800 dark:text-foreground",
  "border-border bg-card text-cyan-800 dark:text-foreground",
  "border-border bg-card text-fuchsia-800 dark:text-foreground",
];

function asNonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeNameSeed(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function getEmailLocalPart(email: string | null | undefined): string | null {
  const [localPart = ""] = email?.split("@") ?? [];
  const normalized = normalizeNameSeed(localPart);
  return normalized ? toTitleCase(normalized) : null;
}

function getWords(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function hashString(value: string): number {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

export function getProjectAssigneeDisplayName(profile: ProjectAssigneeProfile | null | undefined): string {
  if (!profile) {
    return "Unassigned";
  }

  const givenName = asNonEmptyString(profile.givenName);
  const familyName = asNonEmptyString(profile.familyName);

  if (givenName && familyName) {
    return `${givenName} ${familyName}`;
  }

  const fullName = asNonEmptyString(profile.fullName);
  if (fullName) {
    return fullName;
  }

  if (givenName) {
    return givenName;
  }

  if (familyName) {
    return familyName;
  }

  return getEmailLocalPart(profile.email) ?? profile.email ?? "Unassigned";
}

export function getProjectAssigneeInitials(profile: ProjectAssigneeProfile | null | undefined): string | null {
  if (!profile) {
    return null;
  }

  const givenName = asNonEmptyString(profile.givenName);
  const familyName = asNonEmptyString(profile.familyName);

  if (givenName && familyName) {
    return `${givenName.charAt(0)}${familyName.charAt(0)}`.toUpperCase();
  }

  const displayName = getProjectAssigneeDisplayName(profile);
  const words = getWords(displayName);

  if (words.length >= 2) {
    return `${words[0]?.charAt(0) ?? ""}${words[1]?.charAt(0) ?? ""}`.toUpperCase();
  }

  const singleWord = words[0] ?? "";
  const normalizedWord = singleWord.replace(/\s+/g, "");
  return normalizedWord.slice(0, 2).toUpperCase() || null;
}

export function getProjectAssigneeBubbleColor(profile: ProjectAssigneeProfile | null | undefined): string | null {
  if (!profile) {
    return null;
  }

  const stableSeed = profile.userId || profile.email || getProjectAssigneeDisplayName(profile);
  const paletteIndex = hashString(stableSeed) % ASSIGNEE_BUBBLE_COLORS.length;
  return ASSIGNEE_BUBBLE_COLORS[paletteIndex] ?? ASSIGNEE_BUBBLE_COLORS[0];
}

export function buildProjectAssigneeBadgeModel(
  profile: ProjectAssigneeProfile | null | undefined,
): ProjectAssigneeBadgeModel {
  if (!profile) {
    return {
      displayName: "Unassigned",
      initials: null,
      colorClassName: null,
      isUnassigned: true,
    };
  }

  return {
    displayName: getProjectAssigneeDisplayName(profile),
    initials: getProjectAssigneeInitials(profile),
    colorClassName: getProjectAssigneeBubbleColor(profile),
    isUnassigned: false,
  };
}
