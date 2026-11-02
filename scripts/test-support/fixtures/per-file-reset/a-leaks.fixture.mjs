// Runs first and leaves state behind for b-reads.fixture.mjs.
import { expect, test, vi } from "vitest";
import { value } from "./dep.mjs";

vi.mock("./dep.mjs", () => ({ value: "mocked" }));

test("leaves a mock, an env var, a fake clock and a listener behind", () => {
  expect(value).toBe("mocked");
  process.env.OVD_PER_FILE_RESET_CANARY = "leaked";
  vi.useFakeTimers();
  process.on("warning", () => {});
});
