import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import JarvisArPreview from "./JarvisArPreview";

afterEach(cleanup);
it("keeps AR inside the MORE sheet while OPEN 3D stays visible", () => {
  render(<JarvisArPreview />);
  expect(screen.getByRole("link", { name: "OPEN 3D" })).toBeTruthy();
  expect(screen.queryByLabelText("PLATE_R1 options")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "MORE" }));
  expect(screen.getByLabelText("PLATE_R1 options")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("PLATE_R1 options")).toBeNull();
});
