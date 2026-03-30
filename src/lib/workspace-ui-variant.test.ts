import { describe, expect, it } from "vitest";
import { resolveWorkspaceUiVariant } from "@/lib/workspace-ui-variant";

describe("workspace-ui-variant", () => {
  it("keeps classic variant when env flag is disabled", () => {
    expect(
      resolveWorkspaceUiVariant({
        envEnableNorthStarUi: "0",
        urlSearch: "?north_star_ui=1",
        isInternalUser: false,
      }),
    ).toBe("classic");
  });

  it("keeps classic variant by default for client users without preview query", () => {
    expect(
      resolveWorkspaceUiVariant({
        envEnableNorthStarUi: "1",
        urlSearch: "",
        isInternalUser: false,
      }),
    ).toBe("classic");
  });

  it("enables north star preview only when both gates are enabled", () => {
    expect(
      resolveWorkspaceUiVariant({
        envEnableNorthStarUi: "true",
        urlSearch: "?north_star_ui=1",
        isInternalUser: false,
      }),
    ).toBe("north_star_preview");
  });

  it("keeps internal users on classic variant even if both gates are enabled", () => {
    expect(
      resolveWorkspaceUiVariant({
        envEnableNorthStarUi: "1",
        urlSearch: "?north_star_ui=1",
        isInternalUser: true,
      }),
    ).toBe("classic");
  });
});
