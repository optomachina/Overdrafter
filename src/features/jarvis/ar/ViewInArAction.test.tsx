import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewInArAction } from "./ViewInArAction";
import { AR_SAFARI, AR_UNAVAILABLE } from "./ar-support";
import { model, ios, android, desktop } from "./ar-fixtures";

afterEach(cleanup);
const base = { ...model, posterUrl: "/plate.png", onRetry: vi.fn() };
describe("ViewInArAction", () => {
  it("renders the Quick Look anchor with an image child", () => {
    render(<ViewInArAction {...base} device={ios} />);
    const link = screen.getByRole("link", { name: "View in AR" });
    expect(link.getAttribute("rel")).toBe("ar");
    expect(link.getAttribute("href")).toBe(model.usdzUrl);
    expect(link.firstElementChild?.tagName).toBe("IMG");
  });
  it("renders the Scene Viewer intent", () => {
    render(<ViewInArAction {...base} device={android} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("intent://arvr.google.com/scene-viewer/1.0?file=https%3A%2F%2Ffiles.example%2Fplate.glb%3Fsig%3Da%2Bb%26v%3D1&mode=ar_preferred&title=Plate%20%26%20review#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;S.browser_fallback_url=https%3A%2F%2Fapp.example%2Fmodel%3Fid%3D1%26view%3D3d;end;");
  });
  it.each([
    { device: desktop }, { device: ios, usdzUrl: undefined },
    { device: android, glbUrl: "http://files.example/plate.glb" },
  ])("hides the action and explains unsupported devices: %j", (props) => {
    render(<ViewInArAction {...base} {...props} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(AR_UNAVAILABLE)).toBeTruthy();
  });
  it("disables AR in standalone and offers the model share URL", () => {
    render(<ViewInArAction {...base} device={{ ...ios, standalone: true }} />);
    expect((screen.getByRole("button", { name: "View in AR" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(AR_SAFARI)).toBeTruthy();
    expect(screen.getByRole("link", { name: "OPEN IN SAFARI" }).getAttribute("href")).toBe(model.viewUrl);
  });
  it("shows quiet loading status without launch controls", () => {
    render(<ViewInArAction {...base} status="loading" />);
    expect(screen.getByRole("status").textContent).toBe("Preparing AR view");
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("offers retry after failure", () => {
    const onRetry = vi.fn();
    render(<ViewInArAction {...base} status="failed" onRetry={onRetry} />);
    expect(screen.getByText("AR view could not open.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "TRY AGAIN" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
