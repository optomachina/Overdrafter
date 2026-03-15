import { describe, expect, it } from "vitest";
import { getUserFacingErrorMessage, toUserFacingError } from "./error-message";

describe("error-message", () => {
  it("prefers Error messages", () => {
    expect(getUserFacingErrorMessage(new Error("Download failed"), "fallback")).toBe("Download failed");
  });

  it("reads plain object messages", () => {
    expect(getUserFacingErrorMessage({ message: "permission denied" }, "fallback")).toBe("permission denied");
  });

  it("serializes PostgREST-style objects when needed", () => {
    expect(
      getUserFacingErrorMessage(
        {
          code: "42501",
          details: "new row violates row-level security policy",
          hint: "Check storage policies",
        },
        "fallback",
      ),
    ).toBe('{"code":"42501","details":"new row violates row-level security policy","hint":"Check storage policies"}');
  });

  it("falls back for empty objects", () => {
    expect(getUserFacingErrorMessage({}, "fallback")).toBe("fallback");
  });

  it("falls back when an Error message is just an empty object payload", () => {
    const error = Object.assign(new Error("{}"), {
      name: "StorageUnknownError",
      originalError: {},
    });

    expect(getUserFacingErrorMessage(error, "fallback")).toBe("fallback");
  });

  it("wraps raw objects as real errors while preserving metadata", () => {
    const error = toUserFacingError(
      {
        name: "StorageApiError",
        message: "Object not found",
        code: "404",
        status: 404,
      },
      "fallback",
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Object not found");
    expect(error.name).toBe("StorageApiError");
    expect(error.code).toBe("404");
    expect(error.status).toBe(404);
  });
});
