import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ArMoreAction } from "./ArMoreAction";
import { model, ios } from "@/features/jarvis/ar/ar-fixtures";

afterEach(cleanup);
function Harness() {
  const [status, setStatus] = useState<"ready" | "loading" | "failed">("failed");
  return <ArMoreAction {...model} title="PLATE_R1" posterUrl="/plate.png" status={status} onRetry={() => setStatus("ready")} device={ios} />;
}
it("QA844 focus after TRY AGAIN", () => {
  render(<Harness />);
  const more = screen.getByRole("button", { name: "MORE" });
  fireEvent.click(more);
  const dialog = screen.getByRole("dialog");
  const retry = screen.getByRole("button", { name: /try again/i });
  retry.focus();
  act(() => { retry.click(); });
  const active = document.activeElement;
  console.log(`PROBE after retry: activeElement=${active?.tagName}${active === document.body ? " (body)" : ""} insideDialog=${dialog.contains(active)}`);
  fireEvent.keyDown(active ?? document.body, { key: "Tab" });
  console.log(`PROBE after Tab: insideDialog=${dialog.contains(document.activeElement)} active=${document.activeElement?.textContent}`);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  console.log(`PROBE after Escape: dialogOpen=${screen.queryByRole("dialog") !== null} focusOnMore=${document.activeElement === more}`);
  expect(screen.queryByRole("dialog")).toBeNull();
});
