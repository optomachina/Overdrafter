import { describe, expect, it } from "vitest";
import { resolveWorkspaceUiVariant } from "@/lib/workspace-ui-variant";

describe("resolveWorkspaceUiVariant", () => {
  it("defaults to classic when the env flag is disabled", () => {
    const variant = resolveWorkspaceUiVariant({
      role: "client",
      searchParams: new URLSearchParams("north_star_ui=1"),
      enableNorthStarUiEnv: "0",
    });

    expect(variant).toBe("classic");
  });

  it("defaults to classic when the URL gate is not present", () => {
    const variant = resolveWorkspaceUiVariant({
      role: "client",
      searchParams: new URLSearchParams(),
      enableNorthStarUiEnv: "1",
    });

    expect(variant).toBe("classic");
  });

  it("enables north star preview only when both gates are set", () => {
    const variant = resolveWorkspaceUiVariant({
      role: "client",
      searchParams: new URLSearchParams("north_star_ui=1"),
      enableNorthStarUiEnv: "1",
    });

    expect(variant).toBe("north_star_preview");
  });

  it("keeps internal memberships on classic even when both preview gates are enabled", () => {
    const variant = resolveWorkspaceUiVariant({
      role: "internal_estimator",
      searchParams: new URLSearchParams("north_star_ui=1"),
      enableNorthStarUiEnv: "1",
    });

    expect(variant).toBe("classic");
  });
});
