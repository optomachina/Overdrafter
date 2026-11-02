// Runs second in the same worker; sees none of a-leaks.fixture.mjs's state.
import { expect, test, vi } from "vitest";
import { value } from "./dep.mjs";

vi.setConfig({ testTimeout: 5_000 });

test("imports the real module with a clean environment", () => {
  expect(value).toBe("real");
  expect(process.env.OVD_PER_FILE_RESET_CANARY).toBeUndefined();
  expect(vi.isFakeTimers()).toBe(false);
  expect(process.listenerCount("warning")).toBe(Number(process.env.OVD_PER_FILE_RESET_WARNING_LISTENERS));
});

test("honours vi.setConfig from a file that is not first", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
});
