import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeVendorUrl,
  normalizeVendorIntake,
  normalizeVendorName,
  validateVendorNotes,
  vendorDedupeKey,
  type VendorIntakeReason,
} from "./normalize";

describe("canonicalizeVendorUrl valid cases", () => {
  it.each([
    ["https://example.com", "https://example.com", "example.com"],
    ["EXAMPLE.com/Path/", "https://example.com/Path", "example.com"],
    ["http://www.example.com/", "https://example.com", "example.com"],
    ["https://www.example.com:443/a?utm_source=x&b=2&a=1#frag", "https://example.com/a?a=1&b=2", "example.com"],
    ["  shop.example.co.uk/quote?gclid=1&fbclid=2  ", "https://shop.example.co.uk/quote", "shop.example.co.uk"],
    ["https://bücher.example.org/x", "https://xn--bcher-kva.example.org/x", "xn--bcher-kva.example.org"],
    ["https://example.com./", "https://example.com", "example.com"],
    ["https://xn--80ak6aa92e.com", "https://xn--80ak6aa92e.com", "xn--80ak6aa92e.com"],
    ["www.example.com", "https://example.com", "example.com"],
    ["https://www.foo.com", "https://foo.com", "foo.com"],
    ["https://www.com", "https://www.com", "www.com"],
    ["https://example.com/a?UTM_SOURCE=1&GCLID=x&a=1", "https://example.com/a?a=1", "example.com"],
    ["https://日本語.example.org/x", "https://xn--wgv71a119e.example.org/x", "xn--wgv71a119e.example.org"],
    ["https://xn--wgv71a119e.example.org", "https://xn--wgv71a119e.example.org", "xn--wgv71a119e.example.org"],
  ])("%s", (input, url, host) => {
    expect(canonicalizeVendorUrl(input)).toEqual({ ok: true, value: { url, host, dedupeKey: vendorDedupeKey(host) } });
  });
});

describe("canonicalizeVendorUrl rejections", () => {
  it.each<[string, string, VendorIntakeReason]>([
    ["empty", "   ", "empty"],
    ["over-long", `https://example.com/${"a".repeat(2100)}`, "too_long"],
    ["ftp", "ftp://example.com/file", "url_scheme_unsupported"],
    ["javascript", "javascript:alert(1)", "url_scheme_unsupported"],
    ["data", "data:text/html,hi", "url_scheme_unsupported"],
    ["file", "file:///etc/passwd", "url_scheme_unsupported"],
    ["userinfo", "https://user:pw@example.com", "url_has_userinfo"],
    ["userinfo no password", "https://user@example.com", "url_has_userinfo"],
    ["custom port", "https://example.com:8443", "url_port_unsupported"],
    ["bare host port", "example.com:8080", "url_port_unsupported"],
    ["ipv4", "https://203.0.113.9/", "host_is_ip_literal"],
    ["ipv4 integer form", "http://2130706433/", "host_is_ip_literal"],
    ["ipv6", "https://[2001:db8::1]/", "host_is_ip_literal"],
    ["ipv6 loopback", "http://[::1]:80/", "host_is_ip_literal"],
    ["localhost", "http://localhost", "host_not_public"],
    ["single label", "https://intranet", "host_not_public"],
    [".internal", "https://api.service.internal", "host_not_public"],
    [".local", "https://printer.local", "host_not_public"],
    [".localhost", "https://app.localhost", "host_not_public"],
    ["mixed script homograph", "https://аpple.com", "host_mixed_script"],
    ["punycode mixed script homograph", "https://xn--pple-43d.com", "host_mixed_script"],
    ["punycode mixed script in subdomain", "https://www.xn--pple-43d.example.com/x", "host_mixed_script"],
    ["invalid punycode (rejected by URL parser)", "https://xn--a-ecp.ru.xn--9.com", "url_invalid"],
    ["single label not in suffix list", "https://foo", "host_not_public"],
    ["control char", "https://exa\u0000mple.com", "url_invalid"],
    ["inner space", "https://exa mple.com", "url_invalid"],
    ["underscore host", "https://ex_ample.com", "host_invalid"],
    ["backslash userinfo trick", "https://example.com\\@evil.com", "url_has_userinfo"],
  ])("%s", (_label, input, reason) => {
    expect(canonicalizeVendorUrl(input)).toEqual({ ok: false, reason });
  });
});

describe("length boundaries", () => {
  const withLength = (prefix: string, total: number) => `${prefix}${"a".repeat(total - prefix.length)}`;
  const hostOfLength = (total: number) => `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(total - 192)}`;
  it("accepts a 2048-char URL and rejects 2049", () => {
    expect(canonicalizeVendorUrl(withLength("https://example.com/", 2048)).ok).toBe(true);
    expect(canonicalizeVendorUrl(withLength("https://example.com/", 2049))).toEqual({ ok: false, reason: "too_long" });
  });
  it("accepts a 253-char host and rejects 254", () => {
    expect(hostOfLength(253)).toHaveLength(253);
    expect(canonicalizeVendorUrl(`https://${hostOfLength(253)}`).ok).toBe(true);
    expect(canonicalizeVendorUrl(`https://${hostOfLength(254)}`)).toEqual({ ok: false, reason: "too_long" });
  });
  it("accepts a 63-char label and rejects 64", () => {
    expect(canonicalizeVendorUrl(`https://${"a".repeat(63)}.com`).ok).toBe(true);
    expect(canonicalizeVendorUrl(`https://${"a".repeat(64)}.com`)).toEqual({ ok: false, reason: "host_invalid" });
  });
});

describe("dedupe equivalence", () => {
  const variants = [
    "https://example.com",
    "https://www.example.com/",
    "HTTPS://WWW.EXAMPLE.COM",
    "http://example.com/",
    "example.com#top",
    "https://example.com/?utm_source=a&utm_medium=b&gclid=zz",
    "https://example.com:443/#section",
  ];
  it("maps every variant to one dedupe key", () => {
    const keys = new Set(
      variants.map((v) => {
        const r = canonicalizeVendorUrl(v);
        if (r.ok === false) throw new Error(`${v}: ${r.reason}`);
        return r.value.dedupeKey;
      }),
    );
    expect([...keys]).toEqual(["vendor-host:v1:example.com"]);
  });
  it("keeps distinct hosts distinct", () => {
    expect(vendorDedupeKey("a.example.com")).not.toBe(vendorDedupeKey("example.com"));
  });
  it("gives different vendors different keys", () => {
    const key = (url: string) => {
      const r = canonicalizeVendorUrl(url);
      return r.ok === false ? r.reason : r.value.dedupeKey;
    };
    expect(key("https://acme.com")).toBe("vendor-host:v1:acme.com");
    expect(key("https://acme.com")).not.toBe(key("https://globex.com"));
  });
});

describe("name and notes", () => {
  it("normalizes names", () => {
    expect(normalizeVendorName("  Ｆｕｌｌ​width \t  Co\u0007.  ")).toEqual({ ok: true, value: "Fullwidth Co." });
  });
  it.each<[string, VendorIntakeReason]>([
    ["  \n ", "empty"],
    ["​\u0007", "empty"],
    ["x".repeat(121), "too_long"],
  ])("rejects name %j", (input, reason) => {
    expect(normalizeVendorName(input)).toEqual({ ok: false, reason });
  });
  it("accepts a 120 code-point name made of astral characters and rejects 121", () => {
    expect(normalizeVendorName("😀".repeat(120))).toEqual({ ok: true, value: "😀".repeat(120) });
    expect(normalizeVendorName("😀".repeat(121))).toEqual({ ok: false, reason: "too_long" });
  });
  it("turns a tab in notes into a single space", () => {
    expect(validateVendorNotes("a\tb")).toEqual({ ok: true, value: "a b" });
  });
  it("accepts optional notes, keeps newlines, strips controls", () => {
    expect(validateVendorNotes(undefined)).toEqual({ ok: true, value: "" });
    expect(validateVendorNotes(" a\r\nb\u0007 ")).toEqual({ ok: true, value: "a\nb" });
    expect(validateVendorNotes("n".repeat(2001))).toEqual({ ok: false, reason: "too_long" });
  });
  it("reports the failing field and returns a full value on success", () => {
    expect(normalizeVendorIntake({ name: "", url: "https://example.com" })).toEqual({ ok: false, field: "name", reason: "empty" });
    expect(normalizeVendorIntake({ name: "A", url: "ftp://x.com" })).toEqual({
      ok: false,
      field: "url",
      reason: "url_scheme_unsupported",
    });
    expect(normalizeVendorIntake({ name: "A", url: "x.com", notes: "n".repeat(2001) })).toEqual({
      ok: false,
      field: "notes",
      reason: "too_long",
    });
    expect(normalizeVendorIntake({ name: " Acme  Inc ", url: "www.acme.com/?utm_x=1" })).toEqual({
      ok: true,
      value: { name: "Acme Inc", url: "https://acme.com", host: "acme.com", dedupeKey: "vendor-host:v1:acme.com", notes: "" },
    });
  });
});

describe("non-string runtime input", () => {
  const nonStrings: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["number", 5],
    ["object", { a: 1 }],
    ["array", ["a"]],
  ];
  const invalid = { ok: false, reason: "invalid_type" };
  it.each(nonStrings)("canonicalizeVendorUrl and normalizeVendorName reject %s", (_label, value) => {
    expect(canonicalizeVendorUrl(value)).toEqual(invalid);
    expect(normalizeVendorName(value)).toEqual(invalid);
  });
  it.each(nonStrings.slice(2))("validateVendorNotes rejects %s but accepts null and undefined", (_label, value) => {
    expect(validateVendorNotes(value)).toEqual(invalid);
    expect(validateVendorNotes(null)).toEqual({ ok: true, value: "" });
    expect(validateVendorNotes(undefined)).toEqual({ ok: true, value: "" });
  });
  it.each(nonStrings.filter(([label]) => label !== "object"))("normalizeVendorIntake reports a non-object input (%s) on url", (_label, value) => {
    expect(normalizeVendorIntake(value)).toEqual({ ok: false, field: "url", reason: "invalid_type" });
  });
  it("reports the offending field of an object with non-string fields", () => {
    expect(normalizeVendorIntake({ name: 5, url: "x.com" })).toEqual({ ok: false, field: "name", reason: "invalid_type" });
    expect(normalizeVendorIntake({ name: "A", url: null })).toEqual({ ok: false, field: "url", reason: "invalid_type" });
    expect(normalizeVendorIntake({ name: "A", url: "x.com", notes: 5 })).toEqual({ ok: false, field: "notes", reason: "invalid_type" });
  });
  it("never throws on hostile values", () => {
    const hostile: unknown[] = [null, undefined, 0, NaN, 5n, true, Symbol("x"), {}, [], () => 1, new String("x"), Object.create(null), "\ud800", "https://\ud800.com"];
    for (const value of hostile) {
      expect(() => canonicalizeVendorUrl(value)).not.toThrow();
      expect(() => normalizeVendorName(value)).not.toThrow();
      expect(() => validateVendorNotes(value)).not.toThrow();
      expect(() => normalizeVendorIntake(value)).not.toThrow();
      expect(() => normalizeVendorIntake({ name: value, url: value, notes: value })).not.toThrow();
    }
  });
});

describe("no I/O", () => {
  it("imports nothing and uses no network, fs, or process APIs", () => {
    const source = readFileSync(path.join(import.meta.dirname, "normalize.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s|\bfrom\s+["']|\brequire\s*\(|\bimport\s*\(/m);
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process|dns)\b|node:|\bnet\./);
  });
});
