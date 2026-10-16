// @vitest-environment node
/**
 * OVD-825 reachability gate. Lives under src/ so `npm test` collects it; the
 * manifest and analyzer live in e2e/journeys/. See e2e/journeys/README.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capabilityManifest, type CapabilitySurface } from "../../e2e/journeys/capability-manifest";
import {
  evaluateManifest,
  evaluateSurface,
  formatReachabilityTable,
  memoryReader,
  resolveAppRoutes,
  type SourceReader,
} from "../../e2e/journeys/reachability";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const repoReader: SourceReader = {
  read(path) {
    const absolute = join(repoRoot, path);
    return existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute, "utf8") : null;
  },
  list(dir) {
    const absolute = join(repoRoot, dir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { recursive: true, encoding: "utf8" })
      .map((entry) => `${dir}/${entry.split("\\").join("/")}`)
      .filter((path) => !path.includes("/node_modules/") && statSync(join(repoRoot, path)).isFile());
  },
};

describe("capability manifest reachability (OVD-825)", () => {
  const results = evaluateManifest(repoReader, capabilityManifest);

  it("prints the per-surface reachability table", () => {
    console.log(`\nCapability reachability (no flags, non-admin user)\n${formatReachabilityTable(results)}\n`);
    expect(results.map((result) => result.id)).toEqual(capabilityManifest.map((surface) => surface.id));
  });

  it("has unique surface ids", () => {
    const ids = capabilityManifest.map((surface) => surface.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(capabilityManifest.map((surface) => [surface.id]))("%s has a reachable front door or is a still-missing known gap", (id) => {
    const result = results.find((candidate) => candidate.id === id);
    expect(result?.failure ?? null, result?.failure ?? "").toBeNull();
  });
});

const APP = `
import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Admin from "./pages/Admin";
const Flagged = import.meta.env.VITE_ENABLE_FLAGGED === "1" ? lazy(() => import("./pages/Flagged")) : null;
const devOnly = import.meta.env.DEV;
export const App = () => (
  <Routes>
    {Flagged && <Route path="/flagged" element={<Flagged />} />}
    {devOnly ? <Route path="/dev-thing" element={<Home />} /> : <Route path="/fallback" element={<Home />} />}
    <Route path="/" element={<Home />} />
    <Route path="/admin-page" element={<Admin />} />
    <Route path="/internal/ops" element={<Home />} />
    <Route path="*" element={<Home />} />
  </Routes>
);
`;

const fixtureFiles: Record<string, string> = {
  "src/App.tsx": APP,
  "src/pages/Home.tsx": `export default function Home() { return <a href="/fallback">go</a>; }`,
  "src/pages/Flagged.tsx": `export default function Flagged() { return null; }`,
  "src/pages/Admin.tsx": `
    export default function Admin() {
      const admitted = useAdmission("api_get_is_platform_admin");
      return admitted ? <main /> : null;
    }`,
  "api/demo-slack.ts": `if (process.env.JARVIS_DEMO_ENABLED !== "1") throw new Error("off");`,
  "vercel.json": JSON.stringify({ rewrites: [{ source: "/hooks/slack", destination: "/api/demo-slack" }, { source: "/(.*)", destination: "/index.html" }] }),
};

function surface(overrides: Partial<CapabilitySurface>): CapabilitySurface {
  return { id: "fixture", name: "Fixture", linearIssue: "OVD-825", entryPoints: [], ...overrides };
}

describe("reachability analyzer (fixture manifest)", () => {
  const reader = memoryReader(fixtureFiles);

  it("fails an unflagged surface with no entry point", () => {
    const result = evaluateSurface(reader, surface({ id: "orphan" }));
    expect(result.status).toBe("unreachable");
    expect(result.failure).toMatch(/surface orphan has no reachable entry point/);
  });

  it("fails a surface whose route does not exist", () => {
    const result = evaluateSurface(reader, surface({ entryPoints: [{ kind: "route", path: "/missing" }] }));
    expect(result.status).toBe("unreachable");
    expect(result.entryPoints[0].detail).toMatch(/no route/);
  });

  it("counts a flag-gated route as unreachable", () => {
    const result = evaluateSurface(reader, surface({ entryPoints: [{ kind: "route", path: "/flagged" }] }));
    expect(result.reachable).toBe(false);
    expect(result.entryPoints[0].detail).toMatch(/flag-gated by VITE_ENABLE_FLAGGED/);
  });

  it("traces a condition through a local constant to import.meta.env.DEV", () => {
    const routes = resolveAppRoutes(reader);
    expect(routes.find((route) => route.path === "/dev-thing")?.gates).toEqual([
      expect.objectContaining({ kind: "flag", flags: ["DEV"] }),
    ]);
    // The else branch renders when the flag is off, so it is not gated.
    expect(routes.find((route) => route.path === "/fallback")?.gates).toEqual([]);
  });

  it("counts an admin-only route as unreachable, by page admission and by staff path", () => {
    for (const path of ["/admin-page", "/internal/ops"]) {
      const result = evaluateSurface(reader, surface({ entryPoints: [{ kind: "route", path }] }));
      expect(result.reachable, path).toBe(false);
      expect(result.entryPoints[0].detail, path).toMatch(/admin-only/);
    }
  });

  it("treats a demo-switched channel handler as unreachable", () => {
    const result = evaluateSurface(
      reader,
      surface({ channel: "slack", entryPoints: [{ kind: "webhook", path: "/hooks/slack" }] }),
    );
    expect(result.entryPoints[0].detail).toMatch(/demo-only/);
    expect(result.channelHandlers).toEqual([]);
    expect(result.status).toBe("unreachable");
  });

  it("accepts an open route and a link to it", () => {
    const result = evaluateSurface(
      reader,
      surface({ entryPoints: [{ kind: "route", path: "/" }, { kind: "link", from: "/", to: "/fallback" }] }),
    );
    expect(result.entryPoints.map((entry) => entry.reachable)).toEqual([true, true]);
    expect(result.status).toBe("reachable");
  });

  it("keeps a still-missing knownMissing surface green", () => {
    const result = evaluateSurface(
      reader,
      surface({ entryPoints: [{ kind: "route", path: "/flagged" }], knownMissing: { issue: "OVD-805", reason: "fixture" } }),
    );
    expect(result.status).toBe("knownMissing");
    expect(result.failure).toBeNull();
  });

  it("ratchets: a knownMissing surface that becomes reachable fails", () => {
    const result = evaluateSurface(
      reader,
      surface({ id: "fixed", entryPoints: [{ kind: "route", path: "/" }], knownMissing: { issue: "OVD-805", reason: "fixture" } }),
    );
    expect(result.status).toBe("nowReachable");
    expect(result.failure).toMatch(/surface fixed is now reachable; remove knownMissing/);
  });

  it("ratchets a channel when a production handler ships at an unplanned path", () => {
    const shipped = memoryReader({ ...fixtureFiles, "api/channels/slack-events.ts": "export default async function handler() {}" });
    const result = evaluateSurface(
      shipped,
      surface({ id: "slack", channel: "slack", entryPoints: [{ kind: "webhook", path: "/api/jarvis/slack" }], knownMissing: { issue: "OVD-807", reason: "fixture" } }),
    );
    expect(result.channelHandlers).toEqual(["api/channels/slack-events.ts"]);
    expect(result.failure).toMatch(/now reachable/);
  });
});
