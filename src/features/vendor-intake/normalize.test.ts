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
  ])("%s", (_label, input, reason) => {
    expect(canonicalizeVendorUrl(input)).toEqual({ ok: false, reason });
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

describe("no I/O", () => {
  it("imports nothing and uses no network, fs, or process APIs", () => {
    const source = readFileSync(path.join(import.meta.dirname, "normalize.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s|\bfrom\s+["']|\brequire\s*\(|\bimport\s*\(/m);
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process|dns)\b|node:|\bnet\./);
  });
});
