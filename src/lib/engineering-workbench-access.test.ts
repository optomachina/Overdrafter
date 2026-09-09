import { describe, expect, it } from "vitest";
import { canOpenEngineeringWorkbench } from "./engineering-workbench-access";

describe("internal engineering workbench admission", () => {
  it("requires development, explicit opt-in and a loopback host together", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(canOpenEngineeringWorkbench(true, "1", host)).toBe(true);
      expect(canOpenEngineeringWorkbench(false, "1", host)).toBe(false);
      expect(canOpenEngineeringWorkbench(true, undefined, host)).toBe(false);
    }
  });

  it("rejects remote, lookalike and missing hosts even with the flag", () => {
    for (const host of ["overdrafter.com", "localhost.example.com", "127.0.0.1.example.com", "192.168.1.2", ""]) {
      expect(canOpenEngineeringWorkbench(true, "1", host)).toBe(false);
    }
    expect(canOpenEngineeringWorkbench(true, "true", "localhost")).toBe(false);
  });
});
