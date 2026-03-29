import { describe, expect, it } from "vitest";
import { resolveWorkspaceUiVariant } from "@/lib/workspace-ui-variant";

describe("resolveWorkspaceUiVariant", () => {
  it("defaults to classic when env is disabled", () => {
    expect(
      resolveWorkspaceUiVariant({
        role: "client",
        enableNorthStarUiEnv: "0",
        search: "?north_star_ui=1",
      }),
    ).toBe("classic");
  });

  it("defaults to classic for client users without query override", () => {
    expect(
      resolveWorkspaceUiVariant({
        role: "client",
        enableNorthStarUiEnv: "1",
        search: "",
      }),
    ).toBe("classic");
  });

  it("enables preview only when both gates are satisfied", () => {
    expect(
      resolveWorkspaceUiVariant({
        role: "client",
        enableNorthStarUiEnv: "true",
        search: "?north_star_ui=1",
      }),
    ).toBe("north_star_preview");
  });

  it("always keeps internal users on classic", () => {
    expect(
      resolveWorkspaceUiVariant({
        role: "internal_admin",
        enableNorthStarUiEnv: "1",
        search: "?north_star_ui=1",
      }),
    ).toBe("classic");
  });
});
