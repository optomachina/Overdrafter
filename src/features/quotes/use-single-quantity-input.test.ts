import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClientPartRequestUpdateInput } from "./types";
import { useSingleQuantityInput } from "./use-single-quantity-input";

const editable = { allowAboveOne: true, loading: false, unavailable: false };

describe("useSingleQuantityInput", () => {
  it("blocks an empty edit immediately but holds the error until blur, then recovers", () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useSingleQuantityInput({ quantity: 1, requestedQuoteQuantities: [1] } as ClientPartRequestUpdateInput, editable, onChange));
    act(() => result.current.onTextChange(""));
    expect(result.current).toMatchObject({ value: "", blocked: true, showError: false });
    expect(onChange).not.toHaveBeenCalled();
    act(() => result.current.onBlur());
    expect(result.current.showError).toBe(true);
    act(() => result.current.onTextChange("50"));
    expect(result.current).toMatchObject({ value: "50", blocked: false, showError: false });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ quantity: 50 });
  });

  it.each(["12.5", "1,000", "-5", "0", "abc"])("retains %j without emitting a changed quantity", (text) => {
    const onChange = vi.fn();
    const { result } = renderHook(() => useSingleQuantityInput({ quantity: 1, requestedQuoteQuantities: [1] } as ClientPartRequestUpdateInput, editable, onChange));
    act(() => result.current.onTextChange(text));
    expect(result.current).toMatchObject({ value: text, blocked: true, showError: true });
    expect(onChange).not.toHaveBeenCalled();
  });
});
