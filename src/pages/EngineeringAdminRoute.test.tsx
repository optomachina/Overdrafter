import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EngineeringAdminRoute from "./EngineeringAdminRoute";

const mocks = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn(), inboxLoaded: vi.fn() }));
vi.mock("@/hooks/use-app-session", () => ({ useAppSession: mocks.session }));
vi.mock("@/features/quotes/api/shared/rpc", () => ({ callRpc: mocks.rpc }));
vi.mock("./EngineeringInbox", () => {
  mocks.inboxLoaded();
  return { default: () => <p>Engineering inbox fixture</p> };
});

const notFound = "The route you requested does not exist in this app.";
const signedIn = (id = "admin-user") => ({ user: { id }, authState: "authenticated", isAuthInitializing: false, isPlatformAdmin: false });

function tree() {
  return <MemoryRouter initialEntries={["/engineering"]}><EngineeringAdminRoute /></MemoryRouter>;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(cleanup);

describe("hosted engineering admin route", () => {
  it("shows the ordinary not found page to signed out visitors without asking the server", () => {
    mocks.session.mockReturnValue({ user: null, authState: "anonymous", isAuthInitializing: false, isPlatformAdmin: false });
    render(tree());
    expect(screen.getByText(notFound)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("renders nothing while the session is still resolving", () => {
    mocks.session.mockReturnValue({ user: null, authState: "anonymous", isAuthInitializing: true, isPlatformAdmin: false });
    const { container } = render(tree());
    expect(container).toBeEmptyDOMElement();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("denies a signed in user the server does not list as an admin, even with a cached admin flag", async () => {
    mocks.session.mockReturnValue({ ...signedIn("client-user"), isPlatformAdmin: true });
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    render(tree());
    expect(await screen.findByText(notFound)).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith("api_get_is_platform_admin");
    expect(screen.queryByText("Engineering inbox fixture")).not.toBeInTheDocument();
  });

  it.each([
    ["an RPC error", () => mocks.rpc.mockResolvedValue({ data: true, error: { message: "denied" } })],
    ["a rejected request", () => mocks.rpc.mockRejectedValue(new Error("offline"))],
    ["a non boolean answer", () => mocks.rpc.mockResolvedValue({ data: "true", error: null })],
  ])("fails closed on %s", async (_label, arrange) => {
    mocks.session.mockReturnValue(signedIn());
    arrange();
    render(tree());
    expect(await screen.findByText(notFound)).toBeInTheDocument();
    expect(screen.queryByText("Engineering inbox fixture")).not.toBeInTheDocument();
  });

  it("opens the engineering inbox only after the server admits the caller", async () => {
    mocks.session.mockReturnValue(signedIn());
    let admit: (value: unknown) => void = () => {};
    mocks.rpc.mockReturnValue(new Promise((resolve) => { admit = resolve; }));
    const { container } = render(tree());
    expect(container).toBeEmptyDOMElement();
    admit({ data: true, error: null });
    expect(await screen.findByText("Engineering inbox fixture")).toBeInTheDocument();
    expect(screen.queryByText(notFound)).not.toBeInTheDocument();
  });

  it("rechecks the server when the signed in account changes", async () => {
    mocks.session.mockReturnValue(signedIn("admin-user"));
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    const view = render(tree());
    expect(await screen.findByText("Engineering inbox fixture")).toBeInTheDocument();

    mocks.session.mockReturnValue(signedIn("client-user"));
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    view.rerender(tree());
    expect(await screen.findByText(notFound)).toBeInTheDocument();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Engineering inbox fixture")).not.toBeInTheDocument();
  });
});
