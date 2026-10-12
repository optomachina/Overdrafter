import { describe, expect, it } from "vitest";
import { getFoundingBetaUploadMessage } from "@/features/quotes/founding-beta-access";
import { DENY_PATTERNS, containsSensitiveErrorDetail, getUserFacingErrorMessage, toUserFacingError } from "./error-message";

// Synthetic, unsigned JWT shape (three base64url segments starting with "eyJ"):
// {"alg":"none","typ":"JWT"} . {"sub":"synthetic-leak-sentinel"} . "synthetic".
const JWT_SENTINEL = ["eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0", "eyJzdWIiOiJzeW50aGV0aWMtbGVhay1zZW50aW5lbCJ9", "c3ludGhldGlj"].join(".");

// One leaking message per deny pattern, in DENY_PATTERNS order.
const SENSITIVE_MESSAGES: ReadonlyArray<readonly [label: string, message: string]> = [
  ["JWT-shaped token", `Invalid JWT: ${JWT_SENTINEL}`],
  ["service_role identity", 'permission denied for role "service_role"'],
  ["secret API key", "Invalid API key sb_secret_syntheticLeakSentinel"],
  ["Playwright storageState", "Could not read storageState from e2e/.auth/client.json"],
  ["session token dump", '{"access_token":"synthetic","token_type":"bearer","refresh_token":"synthetic"}'],
  ["auth storage key", "Stored session sb-127-auth-token is unreadable"],
  ["cookie header", "Cookie: __session=synthetic; theme=dark"],
  ["stack frame", "TypeError: boom\n    at fn (https://x.invalid/a.js:1:2)"],
  ["internal service hostname", "connect ECONNREFUSED worker-api.prod.svc.cluster.local"],
  ["direct database host", "could not connect to server at db.abcdefghijklmnop.supabase.co"],
  ["private IP address", "connect ETIMEDOUT 10.4.7.19"],
  ["localhost with port", "fetch failed: localhost:54321 refused"],
  ["SQL row detail", 'duplicate key value violates unique constraint "jobs_pkey". Key (id)=(0b1e5c7a-synthetic) already exists.'],
  ["SQL missing object", 'relation "private_provider_accounts" does not exist'],
  ["SQL syntax error", 'syntax error at or near "FROM"'],
  ["SQLSTATE code line", "ERROR: boom SQLSTATE 23505"],
  ["SQL statement text", "failed query: select token from vault.secrets where id = 1"],
];

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

  it("falls back for opaque storage sentinel payloads", () => {
    expect(
      getUserFacingErrorMessage(
        {
          __isStorageError: true,
          name: "StorageUnknownError",
        },
        "fallback",
      ),
    ).toBe("fallback");
  });

  it("falls back when an Error message is the JSON-serialized opaque storage marker", () => {
    const error = Object.assign(new Error('{"__isStorageError":true,"name":"StorageUnknownError"}'), {
      name: "StorageUnknownError",
    });

    expect(getUserFacingErrorMessage(error, "fallback")).toBe("fallback");
  });

  it("falls back when a raw string error is the JSON-serialized opaque storage marker", () => {
    expect(
      getUserFacingErrorMessage('{"__isStorageError":true,"name":"StorageUnknownError"}', "fallback"),
    ).toBe("fallback");
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

describe("customer-visible error deny list", () => {
  it.each(SENSITIVE_MESSAGES)("replaces %s text with the fallback", (_label, message) => {
    expect(getUserFacingErrorMessage(new Error(message))).toBe("Something went wrong.");
    expect(getUserFacingErrorMessage({ message, code: "P0001" }, "fallback")).toBe("fallback");
    expect(getUserFacingErrorMessage(message, "fallback")).toBe("fallback");
  });

  it("keeps one deny pattern per sentinel class", () => {
    expect(DENY_PATTERNS).toHaveLength(SENSITIVE_MESSAGES.length);
    SENSITIVE_MESSAGES.forEach(([label, message], index) => {
      expect(DENY_PATTERNS[index].test(message), label).toBe(true);
    });
  });

  it("keeps ordinary customer copy, support addresses and PostgREST summaries", () => {
    for (const message of [
      "Download failed",
      "Contact support@overdrafter.com for help",
      "new row violates row-level security policy",
      "permission denied",
      "File is larger than 50 MB.",
    ]) {
      expect(containsSensitiveErrorDetail(message), message).toBe(false);
    }
  });

  it("keeps the raw detail on the wrapped error for operator and admin logs", () => {
    const raw = Object.assign(new Error('relation "private_provider_accounts" does not exist'), {
      code: "42P01",
      details: "db.abcdefghijklmnop.supabase.co",
    });
    const wrapped = toUserFacingError(raw, "Could not load quotes.");

    expect(wrapped.message).toBe("Could not load quotes.");
    expect((wrapped as Error & { cause?: unknown }).cause).toBe(raw);
    expect(((wrapped as Error & { cause?: unknown }).cause as Error).message).toBe('relation "private_provider_accounts" does not exist');
    expect(wrapped.code).toBe("42P01");
    expect(wrapped.details).toBe("db.abcdefghijklmnop.supabase.co");
    expect(JSON.stringify(wrapped.message)).not.toContain("private_provider_accounts");
  });

  it("never lets a leaking message through any customer facing wrapper", () => {
    for (const [label, message] of SENSITIVE_MESSAGES) {
      const wrapped = toUserFacingError(new Error(message), "bounded copy");
      expect(wrapped.message, label).toBe("bounded copy");
    }
  });

  it("recognizes a bare stack frame without a function name", () => {
    expect(getUserFacingErrorMessage(new Error("Error: boom\n    at /srv/app/server.ts:12:3"), "fallback")).toBe("fallback");
  });

  it("recognizes tokens embedded in headers, JSON and URL fragments", () => {
    for (const message of [`Bearer ${JWT_SENTINEL}`, `{"jwt":"${JWT_SENTINEL}"}`, `Redirect failed: /auth#token=${JWT_SENTINEL}`]) {
      expect(containsSensitiveErrorDetail(message), message).toBe(true);
    }
  });

  it("evaluates long adversarial input in linear time", () => {
    const inputs = ["at ".repeat(20_000), "at a/b ".repeat(9_000), "eyJ".repeat(20_000), "sb-".repeat(20_000)];
    const started = performance.now();
    for (const input of inputs) expect(containsSensitiveErrorDetail(input)).toBe(false);
    // Unbounded, overlapping patterns take seconds on these inputs; the linear ones take milliseconds.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("replaces a mixed PostgREST payload whose details carry a token and a stack frame", () => {
    expect(
      getUserFacingErrorMessage(
        { code: "PGRST301", details: `${JWT_SENTINEL} at fn (https://x.invalid/a.js:1:2)`, hint: "Check storage policies" },
        "fallback",
      ),
    ).toBe("fallback");
    expect(toUserFacingError(new Error(`service_role ${JWT_SENTINEL}`)).message).toBe("Something went wrong.");
  });

  it("keeps clean customer-facing server messages unchanged", () => {
    const clean = "Founding Beta access and current notice acceptance are required.";
    expect(getUserFacingErrorMessage(new Error(clean), "fallback")).toBe(clean);
    expect(getUserFacingErrorMessage({ code: "P0001", message: clean, details: null, hint: null }, "fallback")).toBe(clean);
    expect(toUserFacingError({ message: clean }).message).toBe(clean);
  });

  it("keeps the support-email upload copy byte-identical", () => {
    for (const status of ["not_enrolled", "revoked", "unavailable"] as const) {
      const message = getFoundingBetaUploadMessage(status);
      expect(getUserFacingErrorMessage(new Error(message), "fallback")).toBe(message);
    }
  });

  it("does not mistake times, URLs or configuration names for leaks", () => {
    for (const message of [
      "Try again at 10:30:00.",
      "Quote expires at 2026-10-04T10:30:00Z.",
      "Upload failed at https://example.invalid/parts/part.step",
      "Archived part deletion requires SUPABASE_SERVICE_ROLE_KEY for storage cleanup.",
      "Invalid Refresh Token: Refresh Token Not Found",
    ]) {
      expect(getUserFacingErrorMessage(new Error(message), "fallback")).toBe(message);
    }
  });
});
