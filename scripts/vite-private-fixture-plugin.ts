import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const PRIVATE_FIXTURE_ROUTE_PREFIX = "/__overdrafter_private_fixtures";

const PRIVATE_FIXTURE_ASSETS: ReadonlyMap<
  string,
  { relativePath: string; contentType: string }
> = new Map([
  [
    `${PRIVATE_FIXTURE_ROUTE_PREFIX}/quoted-sample.step`,
    {
      relativePath: "test-fixtures/quoted-sample/1093-05589-02.STEP",
      contentType: "model/step",
    },
  ],
  [
    `${PRIVATE_FIXTURE_ROUTE_PREFIX}/quoted-sample-drawing.pdf`,
    {
      relativePath: "test-fixtures/quoted-sample/1093-05589-02.pdf",
      contentType: "application/pdf",
    },
  ],
]);

export function resolvePrivateFixtureAsset(requestUrl: string | undefined, repoRoot: string) {
  if (!requestUrl) {
    return null;
  }

  const pathname = new URL(requestUrl, "http://localhost").pathname;
  const asset = PRIVATE_FIXTURE_ASSETS.get(pathname);

  if (!asset) {
    return null;
  }

  return {
    absolutePath: path.resolve(repoRoot, asset.relativePath),
    contentType: asset.contentType,
  };
}

function createFixtureMiddleware(repoRoot: string) {
  return async function servePrivateFixture(
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) {
    const asset = resolvePrivateFixtureAsset(request.url, repoRoot);

    if (!asset) {
      next();
      return;
    }

    try {
      const contents = await readFile(asset.absolutePath);
      response.statusCode = 200;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", asset.contentType);
      response.setHeader("Content-Length", contents.byteLength);
      response.end(contents);
    } catch {
      response.statusCode = 404;
      response.end("Fixture asset unavailable.");
    }
  };
}

/** Serves two allowlisted source fixtures only from local Vite fixture-mode servers. */
export function createPrivateFixturePlugin(repoRoot: string): Plugin {
  const middleware = createFixtureMiddleware(repoRoot);

  return {
    name: "overdrafter-private-fixtures",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
