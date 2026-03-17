export function buildEmbeddedPreviewHref(href: string): string {
  const url = new URL(href, "http://localhost");
  url.searchParams.set("embed", "1");
  url.searchParams.set("debug", url.searchParams.get("debug") ?? "1");
  return `${url.pathname}${url.search}${url.hash}`;
}
