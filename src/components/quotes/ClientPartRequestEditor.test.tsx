import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ClientPartPropertyOverrideField, ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { ClientPartRequestEditor } from "./ClientPartRequestEditor";

type FieldDefaults = Partial<Record<ClientPartPropertyOverrideField, string | number | null>>;

vi.mock("@/components/quotes/RfqLineItemMetadataFields", () => ({
  RfqLineItemMetadataFields: () => <div data-testid="rfq-metadata" />,
}));

function makeDraft(overrides: Partial<ClientPartRequestUpdateInput> = {}): ClientPartRequestUpdateInput {
  return {
    jobId: "job-1",
    description: null,
    partNumber: null,
    revision: null,
    material: "",
    finish: null,
    threads: null,
    tightestToleranceInch: null,
    process: null,
    notes: null,
    quantity: 1,
    requestedQuoteQuantities: [],
    requestedByDate: null,
    requestedServiceKinds: [],
    primaryServiceKind: null,
    serviceNotes: null,
    shipping: {
      requestedByDateOverride: null,
      packagingNotes: null,
      shippingNotes: null,
    },
    certifications: {
      requiredCertifications: [],
      materialCertificationRequired: null,
      certificateOfConformanceRequired: null,
      inspectionLevel: null,
      notes: null,
    },
    sourcing: {
      regionPreferenceOverride: null,
      preferredSuppliers: [],
      materialProvisioning: null,
      notes: null,
    },
    release: {
      releaseStatus: null,
      reviewDisposition: null,
      quoteBlockedUntilRelease: null,
      notes: null,
    },
    ...overrides,
  };
}

const noop = () => {};

describe("ClientPartRequestEditor — reset buttons", () => {
  it("does not expose multi-service controls in the quote-only client editor", () => {
    render(
      <ClientPartRequestEditor
        draft={makeDraft()}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
      />,
    );

    expect(screen.queryByText(/requested services/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Qty")).toBeInTheDocument();
    expect(screen.getByLabelText("Quote quantities")).toBeInTheDocument();
  });

  it("renders a reset button when onResetField is provided and draft differs from default", () => {
    const draft = makeDraft({ material: "modified material" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    const resetButton = screen.getByTitle("Reset to extracted: 6061-T6 aluminum");
    expect(resetButton).toBeInTheDocument();
  });

  it("does not render a reset button when draft matches the default", () => {
    const draft = makeDraft({ material: "6061-T6 aluminum" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    expect(screen.queryByTitle("Reset to extracted: 6061-T6 aluminum")).not.toBeInTheDocument();
  });

  it("does not render a reset button when no default exists for the field", () => {
    const draft = makeDraft({ material: "some material" });
    const fieldDefaults: FieldDefaults = {};

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    expect(screen.queryByRole("button", { name: /reset to extracted/i })).not.toBeInTheDocument();
  });

  it("does not render reset buttons when onResetField is not provided", () => {
    const draft = makeDraft({ material: "modified material" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    expect(screen.queryByTitle("Reset to extracted: 6061-T6 aluminum")).not.toBeInTheDocument();
  });

  it("calls onResetField with the correct field name when clicked", () => {
    const onResetField = vi.fn();
    const draft = makeDraft({ material: "modified material" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={onResetField}
        fieldDefaults={fieldDefaults}
      />,
    );

    fireEvent.click(screen.getByTitle("Reset to extracted: 6061-T6 aluminum"));
    expect(onResetField).toHaveBeenCalledOnce();
    expect(onResetField).toHaveBeenCalledWith("material");
  });
});

describe("ClientPartRequestEditor — tightest tolerance typing", () => {
  const LABEL = "Tightest tolerance (in)";

  // Stateful host mirroring the controller: onChange merges into the draft the editor receives back.
  function renderHost(initial: Partial<ClientPartRequestUpdateInput> = {}) {
    const drafts: ClientPartRequestUpdateInput[] = [];
    const onSave = vi.fn();
    let latest = makeDraft({ material: "6061-T6", ...initial });
    function Host() {
      const [draft, setDraft] = useState(latest);
      latest = draft;
      drafts.push(draft);
      return (
        <ClientPartRequestEditor
          draft={draft}
          quoteQuantityInput=""
          onQuoteQuantityInputChange={noop}
          onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
          onSave={() => onSave(latest)}
          onUploadRevision={noop}
          onResetField={(field) => setDraft((current) => ({ ...current, [field]: 0.005 }))}
          fieldDefaults={{ tightestToleranceInch: 0.005 }}
        />
      );
    }
    render(<Host />);
    const input = () => screen.getByLabelText(LABEL) as HTMLInputElement;
    // One keystroke at a time, appended at the caret (end), re-reading the DOM value after each re-render.
    const type = (text: string) => {
      for (const char of text) {
        fireEvent.change(input(), { target: { value: input().value + char } });
      }
    };
    const backspace = (count = 1) => {
      for (let i = 0; i < count; i += 1) {
        fireEvent.change(input(), { target: { value: input().value.slice(0, -1) } });
      }
    };
    const paste = (text: string) => fireEvent.change(input(), { target: { value: text } });
    return { input, type, backspace, paste, onSave, current: () => latest, drafts };
  }

  it.each([
    ["0.005", 0.005],
    [".005", 0.005],
    ["0.1", 0.1],
    ["1.5e-3", 0.0015],
    ["5.", 5],
  ])("typing %s keystroke by keystroke ends at %s and shows the typed text", (text, expected) => {
    const host = renderHost();
    host.type(text);
    expect(host.input().value).toBe(text);
    expect(host.current().tightestToleranceInch).toBe(expected);
    expect(host.drafts.every((d) => d.tightestToleranceInch === null || Number.isFinite(d.tightestToleranceInch))).toBe(true);
  });

  it("backspaces and retypes to the intended number", () => {
    const host = renderHost();
    host.type("0.005");
    host.backspace(2);
    expect(host.input().value).toBe("0.0");
    host.type("12");
    expect(host.input().value).toBe("0.012");
    expect(host.current().tightestToleranceInch).toBe(0.012);
  });

  it("clears to null and then types 0.004", () => {
    const host = renderHost({ tightestToleranceInch: 0.005 });
    expect(host.input().value).toBe("0.005");
    host.backspace(5);
    expect(host.input().value).toBe("");
    expect(host.current().tightestToleranceInch).toBeNull();
    host.type("0.004");
    expect(host.input().value).toBe("0.004");
    expect(host.current().tightestToleranceInch).toBe(0.004);
  });

  it("clears a single-digit value straight to null", () => {
    const host = renderHost({ tightestToleranceInch: 5 });
    host.backspace();
    expect(host.input().value).toBe("");
    expect(host.current().tightestToleranceInch).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores surrounding whitespace in a pasted value", () => {
    const host = renderHost();
    host.paste("  0.005 ");
    expect(host.current().tightestToleranceInch).toBe(0.005);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("accepts a pasted complete value", () => {
    const host = renderHost();
    host.paste("0.005");
    expect(host.input().value).toBe("0.005");
    expect(host.current().tightestToleranceInch).toBe(0.005);
  });

  it.each(["±0.005", "0.1 mm", "abc", "-0.005", "Infinity", "1e999", "0x10"])(
    "rejects pasted %j without producing NaN or a guessed number, and blocks save",
    (text) => {
      const host = renderHost({ tightestToleranceInch: 0.002 });
      host.paste(text);
      expect(host.input().value).toBe(text);
      expect(host.current().tightestToleranceInch).toBeNull();
      expect(host.drafts.some((d) => Number.isNaN(d.tightestToleranceInch))).toBe(false);
      expect(host.input()).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent(/positive number/i);
      expect(host.input()).toHaveAttribute("aria-describedby", screen.getByRole("alert").id);
      expect(screen.getByRole("button", { name: /save request details/i })).toBeDisabled();
    },
  );

  it("keeps valid typing quiet: all-zero prefixes block Save but raise no alert until blur", () => {
    const host = renderHost();
    for (const prefix of ["0", "0.", "0.0", "0.00"]) {
      host.paste(prefix);
      expect(host.current().tightestToleranceInch).toBeNull();
      expect(host.input()).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /save request details/i })).toBeDisabled();
    }
    // Leaving the field with an unusable value explains why Save is blocked.
    fireEvent.blur(host.input());
    expect(host.input()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/positive number/i);
    // Typing on clears the alert again and completes the value.
    host.type("5");
    expect(host.input().value).toBe("0.005");
    expect(host.current().tightestToleranceInch).toBe(0.005);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save request details/i })).toBeEnabled();
  });

  it("recovers from invalid text when the user corrects it", () => {
    const host = renderHost();
    host.paste("±0.005");
    host.paste("0.005");
    expect(host.current().tightestToleranceInch).toBe(0.005);
    expect(host.input()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save request details/i })).toBeEnabled();
  });

  it("displays an extracted value as typed and keeps label and attributes", () => {
    const host = renderHost({ tightestToleranceInch: 0.005 });
    expect(host.input().value).toBe("0.005");
    expect(host.input()).toHaveAttribute("id", "client-request-tolerance");
    expect(host.input()).toHaveAttribute("inputmode", "decimal");
    expect(host.input()).not.toHaveAttribute("type", "number");
    expect(host.input()).not.toHaveAttribute("aria-invalid");
    expect(screen.getByText(LABEL)).toBeInTheDocument();
  });

  it("saves the typed number", () => {
    const host = renderHost();
    host.type("0.005");
    fireEvent.click(screen.getByRole("button", { name: /save request details/i }));
    expect(host.onSave).toHaveBeenCalledOnce();
    expect(host.onSave.mock.calls[0][0].tightestToleranceInch).toBe(0.005);
  });

  it("resyncs the text when the draft changes from outside (reset to extracted)", () => {
    const host = renderHost({ tightestToleranceInch: 0.1 });
    host.paste("±0.005");
    fireEvent.click(screen.getByTitle("Reset to extracted: 0.005"));
    expect(host.input().value).toBe("0.005");
    expect(host.current().tightestToleranceInch).toBe(0.005);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ClientPartRequestEditor — single Quantity mode (OVD-997)", () => {
  const OPEN = { allowAboveOne: true, loading: false, unavailable: false };
  const FIXED = { allowAboveOne: false, loading: false, unavailable: false };
  const LOADING = { allowAboveOne: false, loading: true, unavailable: false };
  const UNAVAILABLE = { allowAboveOne: false, loading: false, unavailable: true };

  // Stateful host mirroring the controller: onChange merges into the draft the editor receives back.
  function renderHost(
    singleQuantity: { allowAboveOne: boolean; loading: boolean; unavailable: boolean } | undefined,
    initial: Partial<ClientPartRequestUpdateInput> = {},
  ) {
    const onSave = vi.fn();
    let latest = makeDraft({ material: "6061-T6", ...initial });
    function Host() {
      const [draft, setDraft] = useState(latest);
      latest = draft;
      return (
        <ClientPartRequestEditor
          draft={draft}
          quoteQuantityInput="1"
          onQuoteQuantityInputChange={noop}
          onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
          onSave={() => onSave(latest)}
          onUploadRevision={noop}
          singleQuantity={singleQuantity}
        />
      );
    }
    render(<Host />);
    const input = () => screen.getByLabelText("Quantity") as HTMLInputElement;
    const set = (text: string) => fireEvent.change(input(), { target: { value: text } });
    const save = () => screen.getByRole("button", { name: /save request details/i });
    return { input, set, save, onSave, current: () => latest };
  }

  it("keeps Qty and Quote quantities when the mode is off", () => {
    renderHost(undefined);
    expect(screen.getByLabelText("Qty")).toBeInTheDocument();
    expect(screen.getByLabelText("Quote quantities")).toBeInTheDocument();
    expect(screen.queryByLabelText("Quantity")).not.toBeInTheDocument();
  });

  it("shows one Quantity field, default 1, and no Qty or Quote quantities", () => {
    const host = renderHost(OPEN);
    expect(host.input().value).toBe("1");
    expect(host.input()).toHaveAttribute("id", "client-request-quantity");
    expect(host.input()).not.toHaveAttribute("readonly");
    expect(screen.queryByLabelText("Qty")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Quote quantities")).not.toBeInTheDocument();
    expect(screen.getByText("Each request is quoted at one quantity.")).toBeInTheDocument();
    expect(host.save()).toBeEnabled();
  });

  it("lets a scoped participant type any whole quantity, keystroke by keystroke, and save it", () => {
    const host = renderHost(OPEN);
    host.set("");
    expect(host.input().value).toBe("");
    expect(host.current().quantity).toBe(1);
    expect(host.save()).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    host.set("5");
    host.set("50");
    host.set("500000");
    expect(host.input().value).toBe("500000");
    expect(host.current().quantity).toBe(500000);
    expect(host.save()).toBeEnabled();
    fireEvent.click(host.save());
    expect(host.onSave).toHaveBeenCalledOnce();
    expect(host.onSave.mock.calls[0][0].quantity).toBe(500000);
  });

  it.each(["abc", "0", "-2", "2.5", "1e3", "10 / 25", "2147483648", "99999999999999999999"])(
    "refuses %j, keeps the last valid quantity in the draft and blocks save",
    (text) => {
      const host = renderHost(OPEN, { quantity: 3 });
      host.set(text);
      expect(host.input().value).toBe(text);
      expect(host.current().quantity).toBe(3);
      expect(host.input()).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number from 1 to 2,147,483,647.");
      expect(host.save()).toBeDisabled();
    },
  );

  it("explains an emptied field only after the user leaves it, then recovers when corrected", () => {
    const host = renderHost(OPEN);
    host.set("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.blur(host.input());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    host.set("8");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(host.input()).not.toHaveAttribute("aria-invalid");
    expect(host.current().quantity).toBe(8);
    expect(host.save()).toBeEnabled();
  });

  it("is fixed at 1 with an explanation when the server did not scope a larger quantity", () => {
    const host = renderHost(FIXED);
    expect(host.input().value).toBe("1");
    expect(host.input()).toHaveAttribute("readonly");
    expect(screen.getByText(/quotes 1 piece per request/i)).toBeInTheDocument();
    expect(screen.getByText(/turned on for specific requests only/i)).toBeInTheDocument();
    expect(host.input()).toHaveAttribute("aria-describedby", "client-request-quantity-help");
    expect(host.save()).toBeEnabled();
    host.set("5");
    expect(host.input().value).toBe("1");
    expect(host.current().quantity).toBe(1);
  });

  it("shows 1 and says a save changes it when a larger quantity was saved before", () => {
    const host = renderHost(FIXED, { quantity: 25, requestedQuoteQuantities: [25] });
    expect(host.input().value).toBe("1");
    expect(
      screen.getByText("This request is saved with quantity 25. Saving sets the quantity to 1."),
    ).toBeInTheDocument();
  });

  it("notes that a save keeps one of several saved quantities", () => {
    const host = renderHost(OPEN, { quantity: 10, requestedQuoteQuantities: [10, 25, 50] });
    expect(host.input().value).toBe("10");
    expect(
      screen.getByText("This request is saved with quantities 10, 25, 50. Saving keeps only quantity 10."),
    ).toBeInTheDocument();
  });

  it("waits for the server answer: read only, explained, and Save is off", () => {
    const host = renderHost(LOADING, { quantity: 4, requestedQuoteQuantities: [4] });
    expect(host.input().value).toBe("4");
    expect(host.input()).toHaveAttribute("readonly");
    expect(screen.getByText("Checking which quantities this request can use.")).toBeInTheDocument();
    expect(screen.queryByText(/saved with/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(host.save()).toBeDisabled();
  });

  it("keeps the saved quantity, says the check failed and keeps Save on when the answer is unavailable", () => {
    const host = renderHost(UNAVAILABLE, { quantity: 25, requestedQuoteQuantities: [25, 50] });
    expect(host.input().value).toBe("25");
    expect(host.input()).toHaveAttribute("readonly");
    expect(screen.getByText(/could not check which quantities this request can use/i)).toBeInTheDocument();
    expect(screen.getByText(/reload the page to try again/i)).toBeInTheDocument();
    // Not the server's policy: the "specific requests only" copy and the sets-to-1 note must not appear.
    expect(screen.queryByText(/turned on for specific requests only/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/saving sets the quantity to 1/i)).not.toBeInTheDocument();
    expect(
      screen.getByText("This request is saved with quantities 25, 50. Saving keeps them as they are."),
    ).toBeInTheDocument();
    host.set("5");
    expect(host.input().value).toBe("25");
    expect(host.current().quantity).toBe(25);
    expect(host.save()).toBeEnabled();
    fireEvent.click(host.save());
    expect(host.onSave).toHaveBeenCalledOnce();
    expect(host.onSave.mock.calls[0][0]).toMatchObject({ quantity: 25, requestedQuoteQuantities: [25, 50] });
  });

  it("follows the draft when it changes from outside", () => {
    const drafts = [makeDraft({ material: "6061-T6", quantity: 2 }), makeDraft({ material: "6061-T6", quantity: 9 })];
    const view = render(
      <ClientPartRequestEditor
        draft={drafts[0]}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        singleQuantity={OPEN}
      />,
    );
    expect((screen.getByLabelText("Quantity") as HTMLInputElement).value).toBe("2");
    view.rerender(
      <ClientPartRequestEditor
        draft={drafts[1]}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        singleQuantity={OPEN}
      />,
    );
    expect((screen.getByLabelText("Quantity") as HTMLInputElement).value).toBe("9");
  });
});


describe("ClientPartRequestEditor quantities with the flag off (OVD-1023)", () => {
  function renderHost() {
    const onChange = vi.fn();
    const onSave = vi.fn();
    function Host() {
      const [draft, setDraft] = useState(makeDraft({ material: "Aluminum" }));
      const [quoteText, setQuoteText] = useState("");
      return <ClientPartRequestEditor draft={draft} quoteQuantityInput={quoteText}
        onQuoteQuantityInputChange={setQuoteText} onChange={(next) => {
          onChange(next);
          setDraft((current) => ({ ...current, ...next }));
        }} onSave={onSave} onUploadRevision={noop} />;
    }
    render(<Host />);
    return { onChange, onSave, qty: screen.getByLabelText("Qty"),
      quotes: screen.getByLabelText("Quote quantities"),
      save: screen.getByRole("button", { name: /save request details/i }) };
  }

  it.each(["1,000", "", "12.5"])("preserves invalid Qty %j and blocks Save", (text) => {
    const host = renderHost();
    fireEvent.change(host.qty, { target: { value: text } });
    expect(host.qty).toHaveValue(text);
    expect(host.onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number");
    expect(host.save).toBeDisabled();
  });

  it("allows clearing and typing 50 without retaining the initial 1", () => {
    const host = renderHost();
    fireEvent.change(host.qty, { target: { value: "" } });
    for (const value of ["5", "50"]) fireEvent.change(host.qty, { target: { value } });
    expect(host.qty).toHaveValue("50");
    expect(host.onChange).toHaveBeenLastCalledWith({ quantity: 50 });
    expect(host.save).toBeEnabled();
  });

  it("never turns typed 12.5 into 125 or 12 after the decimal", () => {
    const host = renderHost();
    fireEvent.change(host.qty, { target: { value: "" } });
    for (const value of ["1", "12"]) fireEvent.change(host.qty, { target: { value } });
    host.onChange.mockClear();
    for (const value of ["12.", "12.5"]) fireEvent.change(host.qty, { target: { value } });
    expect(host.qty).toHaveValue("12.5");
    expect(host.onChange).not.toHaveBeenCalled();
    expect(host.save).toBeDisabled();
  });

  it("blocks invalid quote quantities and recovers for grouped thousands", () => {
    const host = renderHost();
    fireEvent.change(host.quotes, { target: { value: "10/12.5" } });
    expect(host.save).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter whole numbers separated by /");
    fireEvent.change(host.quotes, { target: { value: "1,000/2,000" } });
    expect(host.save).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Saving sets Qty to 1000, the first quote quantity/)).toBeInTheDocument();
  });
});
