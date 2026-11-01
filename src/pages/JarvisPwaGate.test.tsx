import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import JarvisPwaGate from "./JarvisPwaGate";

const TOKEN = "synthetic-jarvis-gate-token";
const mocks = vi.hoisted(() => ({ verified: vi.fn() }));

vi.mock("./JarvisPwaShell", () => ({
  default: () => <p data-jarvis-pwa-shell>Thread ready</p>,
}));

vi.mock("@/components/auth/MfaStepUpDialog", () => ({
  MfaStepUpDialog: ({ open, onVerified }: { open: boolean; onVerified: () => void }) => (
    open ? <button type="button" onClick={() => { mocks.verified(); onVerified(); }}>Verify authenticator</button> : null
  ),
}));

function renderGate(readToken: () => Promise<string | null>) {
  return render(
    <MemoryRouter initialEntries={["/jarvis"]}>
      <Routes>
        <Route path="/jarvis" element={<JarvisPwaGate readToken={readToken} />} />
        <Route path="/" element={<p>Sign in</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Jarvis PWA gate", () => {
  it("sends a signed out visitor to sign in and does not load the thread", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    renderGate(async () => null);
    expect(await screen.findByText("Sign in")).toBeInTheDocument();
    expect(screen.queryByText("Thread ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Confirm it is you")).not.toBeInTheDocument();
  });

  it("shows the ordinary not found page when the server returns 404, ignoring a forged local role", async () => {
    localStorage.setItem("jarvis-role", "admin");
    localStorage.setItem("JARVIS_PWA_ENABLED", "1");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-jarvis-role")).toBeNull();
      return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderGate(async () => TOKEN);
    expect(await screen.findByText("The route you requested does not exist in this app.")).toBeInTheDocument();
    expect(screen.queryByText("Thread ready")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows the authenticator step up at AAL1 and loads the thread only after the server admits AAL2", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: "aal2_required" }, { status: 403 });
      return Response.json({ thread: { state: "empty" } });
    }));
    renderGate(async () => TOKEN);
    expect(await screen.findByRole("heading", { name: "Confirm it is you" })).toBeInTheDocument();
    expect(screen.queryByText("Thread ready")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify authenticator" }));
    expect(await screen.findByText("Thread ready")).toBeInTheDocument();
    await waitFor(() => expect(calls).toBe(2));
  });

  it("does not load the thread when a 200 carries extra data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ thread: { state: "empty" }, messages: ["plate"] })));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderGate(async () => TOKEN);
    expect(await screen.findByText("The route you requested does not exist in this app.")).toBeInTheDocument();
    expect(screen.queryByText("Thread ready")).not.toBeInTheDocument();
  });
});
