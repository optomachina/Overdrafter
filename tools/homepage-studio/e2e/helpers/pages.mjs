// Shared facts about the public prototype pages.
export const TAGLINE_LINES = ["OverDrafter", "Your agent for", "Building hardware"];
export const MISSION_SENTENCE = "Reduce the time to Mars by 10% through creative and efficient deployment of engineering resources.";
export const PAGE_IDS = ["v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"];
export const BANNED = /(next year|\blater\b|\b20(2[6-9]|3\d)\b|\bQ[1-4]\b|cursor|solidworks|slack)/i;
export const SIZES = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
];

/** Browser-side: the h1 as lines of text (works for <br> lockups and block spans alike). */
export function h1Lines() {
  const h = document.querySelector("h1");
  return h ? h.innerText.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/** Browser-side: all text a reader or assistive tech could meet, minus script and style source. */
export function collectText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, noscript, template").forEach((n) => n.remove());
  const attrs = [];
  document.querySelectorAll("[aria-label], [title], [alt], [placeholder]").forEach((el) => {
    for (const a of ["aria-label", "title", "alt", "placeholder"]) if (el.getAttribute(a)) attrs.push(el.getAttribute(a));
  });
  return { title: document.title, body: clone.textContent.replace(/\s+/g, " "), attrs };
}

/** Browser-side: is the page wider than the viewport? */
export function overflow() {
  const de = document.documentElement;
  return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, bodyScrollWidth: document.body.scrollWidth, innerWidth: window.innerWidth };
}
