import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientQuoteDecisionPanel } from "./ClientQuoteDecisionPanel";
import { PROVIDER_NOTES_MAX_CHARS, sanitizeProviderNotes } from "@/features/quotes/provider-notes";
import { makeClientQuoteOption } from "./test-option-factory";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: () => <div>Quote Chart</div>,
}));

async function renderPanel(notes: string | null) {
  const option = makeClientQuoteOption({ notes });
  render(
    <ClientQuoteDecisionPanel
      options={[option]}
      selectedOption={option}
      onSelect={vi.fn()}
      requestedByDate={null}
    />,
  );
  await waitFor(() => expect(screen.getByText("Quote Chart")).toBeInTheDocument());
}

const COUNTEREXAMPLE = "Tolerance <0.005 in, price > $100 and lead < 5 days";

describe("ClientQuoteDecisionPanel provider notes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders nothing for notes when the flag is off (default)", async () => {
    await renderPanel("Anodize lead time included");
    expect(screen.getByTestId("selected-option-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-notes")).not.toBeInTheDocument();
    expect(screen.queryByText(/Anodize lead time included/)).not.toBeInTheDocument();
  });

  it("renders nothing when the flag is explicitly 0", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "0");
    await renderPanel("Anodize lead time included");
    expect(screen.queryByTestId("provider-notes")).not.toBeInTheDocument();
  });

  it("shows notes for an offer with notes when the flag is on", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    await renderPanel("Anodize lead time included");
    const block = screen.getByTestId("provider-notes");
    expect(within(block).getByText("Anodize lead time included")).toBeInTheDocument();
    expect(within(block).queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows 'No provider notes' when notes are absent or blank", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    await renderPanel("   ");
    expect(within(screen.getByTestId("provider-notes")).getByText("No provider notes")).toBeInTheDocument();
  });

  it("shows 'No provider notes' for null notes", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    await renderPanel(null);
    expect(within(screen.getByTestId("provider-notes")).getByText("No provider notes")).toBeInTheDocument();
  });

  it("renders markup as inert plain text, never as elements", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    await renderPanel('Ship early <img src=x onerror="alert(1)"><script>alert(2)</script>ok');
    const block = screen.getByTestId("provider-notes");
    expect(block.querySelector("img, script")).toBeNull();
    expect(block).toHaveTextContent("Ship early");
    expect(block.textContent).toContain("<img");
    expect(block.textContent).toContain("<script>alert(2)</script>ok");
  });

  it("keeps legitimate angle-bracket text in the rendered panel", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    await renderPanel(COUNTEREXAMPLE);
    expect(screen.getByTestId("provider-notes")).toHaveTextContent(COUNTEREXAMPLE);
  });

  it("bounds long notes behind an accessible expand control", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    const long = "word ".repeat(200).trim();
    await renderPanel(long);
    const block = screen.getByTestId("provider-notes");
    const toggle = within(block).getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(block.textContent?.length ?? 0).toBeLessThan(long.length);

    fireEvent.click(toggle);
    const collapse = within(block).getByRole("button", { name: "Show less" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(block).toHaveTextContent(long);
  });

  it("introduces no order, checkout or PO control", async () => {
    vi.stubEnv("VITE_ENABLE_QUOTE_PROVIDER_NOTES", "1");
    await renderPanel("note");
    expect(within(screen.getByTestId("provider-notes")).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /order|checkout|purchase order|place/i })).not.toBeInTheDocument();
  });
});

describe("sanitizeProviderNotes", () => {
  it("removes control characters and collapses whitespace without touching markup text", () => {
    expect(sanitizeProviderNotes("a\u0000b‮ <b>bold</b>   text\ufeff\u2060x")).toBe("a b <b>bold</b> text x");
  });

  it("preserves the exact angle-bracket counterexample", () => {
    expect(sanitizeProviderNotes(COUNTEREXAMPLE)).toBe(COUNTEREXAMPLE);
  });

  it("handles oversized hostile input within a time bound", () => {
    for (const unit of ["<", "< ", "\n ", " "]) {
      const start = performance.now();
      const out = sanitizeProviderNotes(unit.repeat(500_000));
      expect(performance.now() - start).toBeLessThan(500);
      expect((out ?? "").length).toBeLessThanOrEqual(PROVIDER_NOTES_MAX_CHARS + 1);
    }
  });

  it("does not split surrogate pairs when capping", () => {
    const out = sanitizeProviderNotes("😀".repeat(PROVIDER_NOTES_MAX_CHARS + 5)) ?? "";
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).toBe("😀".repeat(PROVIDER_NOTES_MAX_CHARS));
  });

  it("returns null for non-strings and empty content", () => {
    expect(sanitizeProviderNotes(null)).toBeNull();
    expect(sanitizeProviderNotes(undefined)).toBeNull();
    expect(sanitizeProviderNotes("  \u0000 \n ")).toBeNull();
  });

  it("caps total length", () => {
    const out = sanitizeProviderNotes("x".repeat(PROVIDER_NOTES_MAX_CHARS * 2));
    expect(out?.length).toBe(PROVIDER_NOTES_MAX_CHARS + 1);
  });
});
