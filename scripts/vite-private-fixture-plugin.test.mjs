import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PRIVATE_FIXTURE_ROUTE_PREFIX,
  createPrivateFixturePlugin,
  resolvePrivateFixtureAsset,
} from "./vite-private-fixture-plugin";

const repoRoot = process.cwd();

describe("private Vite fixture server", () => {
  it("resolves only the allowlisted quoted-sample assets", () => {
    expect(
      resolvePrivateFixtureAsset(`${PRIVATE_FIXTURE_ROUTE_PREFIX}/quoted-sample.step?cache=1`, repoRoot),
    ).toEqual({
      absolutePath: path.resolve(
        repoRoot,
        "test-fixtures/quoted-sample/1093-05589-02.STEP",
      ),
      contentType: "model/step",
    });
    expect(
      resolvePrivateFixtureAsset(`${PRIVATE_FIXTURE_ROUTE_PREFIX}/../../package.json`, repoRoot),
    ).toBeNull();
    expect(resolvePrivateFixtureAsset("/fixtures/demo-bracket.step", repoRoot)).toBeNull();
    expect(resolvePrivateFixtureAsset(undefined, repoRoot)).toBeNull();
  });

  it("serves the supplied part only through the registered fixture middleware", async () => {
    const plugin = createPrivateFixturePlugin(repoRoot);
    const devMiddleware = [];
    const previewMiddleware = [];

    plugin.configureServer({ middlewares: { use: (middleware) => devMiddleware.push(middleware) } });
    plugin.configurePreviewServer({
      middlewares: { use: (middleware) => previewMiddleware.push(middleware) },
    });

    expect(devMiddleware).toHaveLength(1);
    expect(previewMiddleware).toEqual(devMiddleware);

    const response = {
      body: null,
      headers: new Map(),
      statusCode: 0,
      setHeader(name, value) {
        this.headers.set(name, value);
      },
      end(body) {
        this.body = body;
      },
    };
    const next = vi.fn();

    await devMiddleware[0](
      { url: `${PRIVATE_FIXTURE_ROUTE_PREFIX}/quoted-sample.step` },
      response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("model/step");
    expect(response.body.subarray(0, 32).toString("ascii")).toMatch(/^ISO-10303-21;/);
  });

  it("passes unknown routes through and fails closed when an allowlisted source is missing", async () => {
    const plugin = createPrivateFixturePlugin(path.join(repoRoot, "missing-fixture-root"));
    const middleware = [];
    plugin.configureServer({ middlewares: { use: (handler) => middleware.push(handler) } });

    const next = vi.fn();
    await middleware[0]({ url: "/unrelated" }, {}, next);
    expect(next).toHaveBeenCalledOnce();

    const response = {
      body: null,
      statusCode: 0,
      setHeader: vi.fn(),
      end(body) {
        this.body = body;
      },
    };
    await middleware[0](
      { url: `${PRIVATE_FIXTURE_ROUTE_PREFIX}/quoted-sample.step` },
      response,
      vi.fn(),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("Fixture asset unavailable.");
  });
});
