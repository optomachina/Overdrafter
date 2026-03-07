export type AppVersionBuildInput = {
  baseVersion: string;
  deploymentEnvironment?: string | null;
  commitCount?: number | null;
  productionBaselineCommitCount?: number | null;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
};

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseBaseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function buildAppVersion({
  baseVersion,
  deploymentEnvironment,
  commitCount,
  productionBaselineCommitCount,
}: AppVersionBuildInput): string {
  const parsed = parseBaseVersion(baseVersion);
  if (!parsed) {
    return baseVersion;
  }

  if (deploymentEnvironment !== "production") {
    return baseVersion;
  }

  if (commitCount == null || productionBaselineCommitCount == null) {
    return baseVersion;
  }

  const patchOffset = Math.max(0, commitCount - productionBaselineCommitCount);

  return `${parsed.major}.${parsed.minor}.${parsed.patch + patchOffset}`;
}
