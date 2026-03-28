import { describe, expect, it } from "vitest";
import { resolveWorkspaceUiVariant } from "./workspace-ui-variant";

describe("workspace-ui-variant", () => {
  it("defaults to classic when the north star flag is disabled", () => {
    expect(resolveWorkspaceUiVariant("?ui=northstar", "0")).toBe("classic");
    expect(resolveWorkspaceUiVariant("?ui=northstar", "false")).toBe("classic");
    expect(resolveWorkspaceUiVariant("?ui=northstar", undefined)).toBe("classic");
  });

  it("keeps classic when no variant query is provided", () => {
    expect(resolveWorkspaceUiVariant("", "1")).toBe("classic");
  });

  it("returns northstar only when the env flag and query toggle are both enabled", () => {
    expect(resolveWorkspaceUiVariant("?ui=northstar", "1")).toBe("northstar");
    expect(resolveWorkspaceUiVariant("?ui=northstar", "true")).toBe("northstar");
    expect(resolveWorkspaceUiVariant("?ui=northstar", "yes")).toBe("northstar");
  });
});
