// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MOBILE_AUTH_BOOTSTRAP_HEADER,
  MOBILE_AUTH_CONTRACT_VERSION,
  MOBILE_AUTH_COOKIE_NAME,
  MOBILE_AUTH_LIFETIMES,
  MOBILE_AUTH_PKCE_METHOD,
  MOBILE_AUTH_RATE_LIMITS,
} from "./contract";

describe("mobile-auth contract constants", () => {
  it("fixes the initial protocol, PKCE method, and security lifetimes", () => {
    expect(MOBILE_AUTH_CONTRACT_VERSION).toBe("1");
    expect(MOBILE_AUTH_PKCE_METHOD).toBe("S256");
    expect(MOBILE_AUTH_COOKIE_NAME).toBe("__Host-ovd-mobile-auth");
    expect(MOBILE_AUTH_BOOTSTRAP_HEADER).toEqual({
      name: "X-OverDrafter-Mobile-Auth",
      value: "bootstrap-v1",
    });
    expect(MOBILE_AUTH_LIFETIMES).toMatchObject({
      browserSeconds: 600,
      handoffSeconds: 90,
      handoffDatabaseMaximumSeconds: 120,
      terminalRowSeconds: 604_800,
      auditSeconds: 2_592_000,
      countersAfterExpirySeconds: 3_600,
    });
    expect(MOBILE_AUTH_RATE_LIMITS).toEqual({
      start: { attempts: 20, windowSeconds: 600 },
      bootstrap: { attempts: 30, windowSeconds: 600 },
    });
  });
});
