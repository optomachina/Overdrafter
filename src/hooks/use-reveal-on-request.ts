import { useEffect, useRef, useState } from "react";

export function useRevealOnRequest() {
  const [requestCount, setRequestCount] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (requestCount === 0) return;
    const heading = headingRef.current;
    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    heading?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion ? "instant" : "smooth" });
    heading?.focus({ preventScroll: true });
  }, [requestCount]);

  return { requestCount, headingRef, requestReveal: () => setRequestCount((count) => count + 1) };
}
