// @vitest-environment node

import { describe, expect, it } from "vitest";
import { isProductionEnvironment, shouldWarnSimulateModeInProduction } from "./runtimeEnvironment";

describe("runtimeEnvironment", () => {
  it("detects production environments across supported env vars", () => {
    expect(isProductionEnvironment({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionEnvironment({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionEnvironment({ APP_ENV: "prod" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isProductionEnvironment({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("warns only when simulate mode is used in production", () => {
    expect(
      shouldWarnSimulateModeInProduction(
        { workerMode: "simulate" },
        { NODE_ENV: "production" } as NodeJS.ProcessEnv,
      ),
    ).toBe(true);
    expect(
      shouldWarnSimulateModeInProduction(
        { workerMode: "live" },
        { NODE_ENV: "production" } as NodeJS.ProcessEnv,
      ),
    ).toBe(false);
    expect(
      shouldWarnSimulateModeInProduction(
        { workerMode: "simulate" },
        { NODE_ENV: "development" } as NodeJS.ProcessEnv,
      ),
    ).toBe(false);
  });
});
