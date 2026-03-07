import { describe, expect, it } from "vitest";

import { buildAppVersion, parseBaseVersion } from "./app-version";

describe("parseBaseVersion", () => {
  it("parses semver triplets", () => {
    expect(parseBaseVersion("0.0.1")).toEqual({ major: 0, minor: 0, patch: 1 });
  });

  it("rejects non-semver strings", () => {
    expect(parseBaseVersion("0.0.1-beta")).toBeNull();
  });
});

describe("buildAppVersion", () => {
  it("keeps the package version outside production deployments", () => {
    expect(
      buildAppVersion({
        baseVersion: "0.0.1",
        deploymentEnvironment: "preview",
        commitCount: 89,
        productionBaselineCommitCount: 88,
      }),
    ).toBe("0.0.1");
  });

  it("increments the patch number for each production commit after the baseline", () => {
    expect(
      buildAppVersion({
        baseVersion: "0.0.1",
        deploymentEnvironment: "production",
        commitCount: 89,
        productionBaselineCommitCount: 88,
      }),
    ).toBe("0.0.2");
  });

  it("does not decrement the patch number when commit history is unavailable", () => {
    expect(
      buildAppVersion({
        baseVersion: "0.0.1",
        deploymentEnvironment: "production",
        commitCount: 80,
        productionBaselineCommitCount: 88,
      }),
    ).toBe("0.0.1");
  });
});
