import { afterEach, describe, expect, it, vi } from "vitest";
import { withLocalFixtureContext } from "./fixture-navigation";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function localMode(hostname = "127.0.0.1") {
  vi.stubEnv("DEV", true);
  vi.stubEnv("MODE", "development");
  vi.stubEnv("VITE_ENABLE_FIXTURE_MODE", "1");
  vi.stubGlobal("window", { location: { hostname, origin: `http://${hostname}:4187`, search: "?fixture=client-published&debug=1" } });
}

describe("local fixture navigation", () => {
  it("preserves an explicit fixture through upload, comparison and return links", () => {
    localMode();
    expect(withLocalFixtureContext("/parts/fx-job-published?app=ios#quotes"))
      .toBe("/parts/fx-job-published?app=ios&fixture=client-published&debug=1#quotes");
    expect(withLocalFixtureContext("/projects/fx-project"))
      .toBe("/projects/fx-project?fixture=client-published&debug=1");
  });

  it("does not enable a fixture without all local opt-ins", () => {
    localMode();
    expect(withLocalFixtureContext("/parts/one", "")).toBe("/parts/one");
    expect(withLocalFixtureContext("/parts/one", "?fixture=unknown")).toBe("/parts/one");
    vi.stubEnv("VITE_ENABLE_FIXTURE_MODE", "0");
    expect(withLocalFixtureContext("/parts/one")).toBe("/parts/one");
    localMode("example.com");
    expect(withLocalFixtureContext("/parts/one")).toBe("/parts/one");
    localMode();
    vi.stubEnv("DEV", false);
    vi.stubEnv("MODE", "production");
    expect(withLocalFixtureContext("/parts/one")).toBe("/parts/one");
  });

  it("never carries fixture context to auth, external, or protocol-relative destinations", () => {
    localMode();
    for (const target of ["/?auth=signin", "/dev-login", "https://example.com/parts", "//example.com/parts", "/\\example.com/parts"]) {
      expect(withLocalFixtureContext(target)).toBe(target);
    }
  });
});
