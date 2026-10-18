import { useEffect, useRef, useState } from "react";

type ScriptedLoopOptions = {
  /** Ticks in one pass of the script. */
  readonly length: number;
  /** Extra ticks to hold the finished frame before the script restarts. */
  readonly holdTicks?: number;
  readonly tickMs?: number;
};

function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/**
 * Drives a looping scripted demo. Returns the host ref and the current tick (0..length).
 * The script only runs while the host is on screen, and it shows its final frame without
 * motion when the visitor prefers reduced motion. Until it first scrolls into view it shows its
 * finished frame, so a page that never runs the script is never an empty window.
 */
export function useScriptedLoop<T extends HTMLElement>({ length, holdTicks = 40, tickMs = 70 }: ScriptedLoopOptions) {
  const hostRef = useRef<T>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [reducedMotion] = useState(prefersReducedMotion);
  const [tick, setTick] = useState(0);
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || reducedMotion) {
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setIsVisible(entry.isIntersecting);
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [reducedMotion]);

  useEffect(() => {
    if (!isVisible || reducedMotion) {
      return;
    }

    setHasStarted(true);
    const interval = window.setInterval(() => {
      setTick((current) => (current >= length + holdTicks ? 0 : current + 1));
    }, tickMs);
    return () => window.clearInterval(interval);
  }, [holdTicks, isVisible, length, reducedMotion, tickMs]);

  return { hostRef, tick: reducedMotion || !hasStarted ? length : Math.min(tick, length), reducedMotion };
}
