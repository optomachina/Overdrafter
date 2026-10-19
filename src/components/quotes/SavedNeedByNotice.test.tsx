import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SavedNeedByNotice } from "./SavedNeedByNotice";

describe("SavedNeedByNotice", () => {
  it("explains that the saved date blocks the controlled beta and the filter is view only", () => {
    render(<SavedNeedByNotice requestedByDate="2026-04-15" onRemove={vi.fn()} />);

    expect(screen.getByText(/Apr 15, 2026/)).toBeInTheDocument();
    expect(screen.getByText(/does not support a Need by date/i)).toBeInTheDocument();
    expect(screen.getByText(/changes this view only/i)).toBeInTheDocument();
  });

  it("removes the saved date only when the user asks", () => {
    const onRemove = vi.fn();
    render(<SavedNeedByNotice requestedByDate="2026-04-15" onRemove={onRemove} />);

    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Need by from request" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("disables removal while a save is pending", () => {
    render(<SavedNeedByNotice requestedByDate="2026-04-15" onRemove={vi.fn()} disabled />);
    expect(screen.getByRole("button", { name: "Remove Need by from request" })).toBeDisabled();
  });

  it("keeps removal enabled by default", () => {
    render(<SavedNeedByNotice requestedByDate="2026-04-15" onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Remove Need by from request" })).toBeEnabled();
  });

  it("warns that removing the date also saves the drawing's thread callouts as Threads (OVD-991)", () => {
    const { rerender } = render(<SavedNeedByNotice requestedByDate="2026-04-15" onRemove={vi.fn()} />);
    expect(screen.queryByText(/thread callouts/i)).not.toBeInTheDocument();

    rerender(<SavedNeedByNotice requestedByDate="2026-04-15" onRemove={vi.fn()} savesDrawingThreads />);
    expect(screen.getByText(/records the thread callouts read from the drawing as Threads/)).toBeInTheDocument();
    expect(screen.getByText(/does not support Threads either/)).toBeInTheDocument();
  });
});
