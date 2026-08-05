import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

describe("TooltipContent", () => {
  it("portals content outside clipped component stacking contexts", () => {
    const { container } = render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent forceMount>Rail action</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const tooltip = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper] > div");

    expect(screen.getAllByText("Rail action")).not.toHaveLength(0);
    expect(tooltip).toBeInTheDocument();
    expect(container).not.toContainElement(tooltip);
  });
});
