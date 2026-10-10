import { getFixtureScenarioIdFromSearch } from "./client-workspace-fixtures";

/** Carry an explicitly enabled local demo through workspace navigation only. */
export function withLocalFixtureContext(target: string, search = window.location.search): string {
  if (
    !(import.meta.env.DEV || import.meta.env.MODE === "test") ||
    import.meta.env.VITE_ENABLE_FIXTURE_MODE !== "1" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) ||
    !target.startsWith("/") || target.startsWith("//")
  ) {
    return target;
  }

  const scenario = getFixtureScenarioIdFromSearch(search);
  const destination = new URL(target, window.location.origin);
  if (
    !scenario ||
    destination.origin !== window.location.origin ||
    !/^\/(parts|projects|quotes)(\/|$)/.test(destination.pathname)
  ) {
    return target;
  }

  destination.searchParams.set("fixture", scenario);
  if (new URLSearchParams(search).get("debug") === "1") {
    destination.searchParams.set("debug", "1");
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}
