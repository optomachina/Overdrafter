import type { User } from "@supabase/supabase-js";

export type AccountDisplayProfile = {
  displayName: string;
  initials: string;
};

type MetadataRecord = Record<string, unknown>;

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeAccountNameSeed(value: string): string {
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

function getMetadataSources(user: User): MetadataRecord[] {
  const sources: MetadataRecord[] = [];

  if (user.user_metadata && typeof user.user_metadata === "object") {
    sources.push(user.user_metadata as MetadataRecord);
  }

  user.identities?.forEach((identity) => {
    if (identity.identity_data && typeof identity.identity_data === "object") {
      sources.push(identity.identity_data as MetadataRecord);
    }
  });

  return sources;
}

function findMetadataString(sources: MetadataRecord[], keys: string[]): string | null {
  for (const source of sources) {
    for (const key of keys) {
      const value = asNonEmptyString(source[key]);

      if (value) {
        return value;
      }
    }
  }

  return null;
}

function getEmailLocalPart(user: User | null): string | null {
  const emailLocalPart = normalizeAccountNameSeed(user?.email?.split("@")[0] ?? "");
  return emailLocalPart ? toTitleCase(emailLocalPart) : null;
}

export function getUserDisplayName(user: User | null): string {
  if (!user) {
    return "Personal workspace";
  }

  const metadataSources = getMetadataSources(user);
  const givenName = findMetadataString(metadataSources, ["given_name", "first_name", "givenName"]);
  const familyName = findMetadataString(metadataSources, ["family_name", "last_name", "familyName"]);

  if (givenName && familyName) {
    return `${givenName} ${familyName}`;
  }

  const metadataName = findMetadataString(metadataSources, ["full_name", "name"]);

  if (metadataName) {
    return metadataName;
  }

  return getEmailLocalPart(user) ?? "Personal workspace";
}

export function getDefaultAccountName(user: User | null): string {
  if (!user) {
    return "Personal workspace";
  }

  const metadataSources = getMetadataSources(user);
  const metadataName = findMetadataString(metadataSources, ["full_name", "name", "company"]);

  if (metadataName) {
    return metadataName;
  }

  return getEmailLocalPart(user) ?? "Personal workspace";
}

export function getAccountDisplayProfile(user: User | null): AccountDisplayProfile {
  const displayName = getUserDisplayName(user);
  const words = displayName
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  const initials =
    words.length >= 2
      ? `${words[0]?.charAt(0) ?? ""}${words[1]?.charAt(0) ?? ""}`
      : (words[0] ?? displayName).slice(0, 2);

  return {
    displayName,
    initials: initials.toUpperCase() || "OD",
  };
}
