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

/**
 * Resolves an exact `/__overdrafter_private_fixtures/<allowlisted-name>` request.
 * Unknown or missing routes return `null`; known routes resolve their fixed
 * repository-relative source to an absolute path plus its response content type.
 */
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

function isLoopbackHost(host: string | boolean | undefined) {
  if (host === undefined || host === false) {
    return true;
  }

  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function assertLoopbackHost(host: string | boolean | undefined) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      "VITE_ENABLE_FIXTURE_MODE may serve supplied fixtures only from a loopback host.",
    );
  }
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
      assertLoopbackHost(server.config.server.host);
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      assertLoopbackHost(server.config.preview.host);
      server.middlewares.use(middleware);
    },
  };
}
