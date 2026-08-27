// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  closeMock,
  displayGetMock,
  displayKillMock,
  launchOptionsMock,
  launchPersistentMock,
} = vi.hoisted(() => ({
  closeMock: vi.fn(),
  displayGetMock: vi.fn(),
  displayKillMock: vi.fn(),
  launchOptionsMock: vi.fn(),
  launchPersistentMock: vi.fn(),
}));

vi.mock("camoufox-js", () => ({ launchOptions: launchOptionsMock }));
vi.mock("camoufox-js/dist/virtdisplay.js", () => ({
  VirtualDisplay: class {
    get = displayGetMock;
    kill = displayKillMock;
  },
}));
vi.mock("playwright", () => ({
  firefox: { launchPersistentContext: launchPersistentMock },
}));

import {
  launchPersistentCamoufox,
  withPersistentCamoufoxContext,
} from "./camoufoxPersistentContext";
import { XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS } from "./xometryAuthProbe";

beforeEach(() => {
  vi.clearAllMocks();
  displayGetMock.mockReturnValue(":41");
  closeMock.mockResolvedValue(undefined);
  launchPersistentMock.mockResolvedValue({ close: closeMock });
});

describe("persistent Camoufox launch", () => {
  it("disables GeoIP discovery for new identity generation", async () => {
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });

    await launchPersistentCamoufox({
      userDataDir: "/profile",
      headless: false,
    });

    expect(launchOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ geoip: false }),
    );
  });

  it("does not allow launch overrides to enable implicit GeoIP discovery", async () => {
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });

    await launchPersistentCamoufox({
      userDataDir: "/profile",
      headless: false,
      launchOverrides: { geoip: true },
    });

    expect(launchOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ geoip: false }),
    );
  });

  it("keeps saved identity recovery discovery-free", async () => {
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });

    await launchPersistentCamoufox({
      userDataDir: "/profile",
      headless: false,
      identityConfig: { "navigator.userAgent": "stable" },
    });

    expect(launchOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ geoip: false }),
    );
  });

  it("passes the offline-first probe contract into Camoufox launch options", async () => {
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });

    await launchPersistentCamoufox({
      userDataDir: "/profile",
      headless: true,
      launchOverrides: XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
    });

    expect(launchOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        offline: true,
        serviceWorkers: "block",
        firefox_user_prefs: {
          "dom.serviceWorkers.enabled": false,
          "media.peerconnection.enabled": false,
          "network.webtransport.enabled": false,
        },
      }),
    );
  });

  it("captures the complete generated configuration and pins it on later launches", async () => {
    launchOptionsMock.mockResolvedValue({
      env: {
        SECRET_THAT_MUST_NOT_BE_PERSISTED: "runtime-only",
        CAMOU_CONFIG_1: '{"navigator.userAgent":"stable",',
        CAMOU_CONFIG_2: '"canvas:aaOffset":17}',
      },
      firefoxUserPrefs: { "webgl.force-enabled": true },
    });

    const first = await launchPersistentCamoufox({
      userDataDir: "/profile",
      headless: false,
    });
    expect(first.identityConfig).toEqual({
      "navigator.userAgent": "stable",
      "canvas:aaOffset": 17,
    });

    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"canvas:aaOffset":-29}' },
    });
    await launchPersistentCamoufox({
      userDataDir: "/profile",
      headless: false,
      identityConfig: first.identityConfig,
    });
    expect(launchOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ geoip: false }),
    );
    expect(launchPersistentMock).toHaveBeenLastCalledWith(
      "/profile",
      expect.objectContaining({
        env: expect.objectContaining({
          CAMOU_CONFIG_1: JSON.stringify(first.identityConfig),
        }),
      }),
    );
  });

  it("runs headfully in Xvfb and waits for Firefox to close before killing the display", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");
    let finishClose = () => undefined;
    closeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });

    try {
      const { context } = await launchPersistentCamoufox({
        userDataDir: "/profile",
        headless: true,
      });
      expect(launchOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          headless: false,
          virtual_display: ":41",
        }),
      );

      const closing = context.close();
      expect(displayKillMock).not.toHaveBeenCalled();
      finishClose();
      await closing;
      expect(displayKillMock).toHaveBeenCalledOnce();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("runs headfully without Xvfb when the host does not support virtual displays", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("darwin");
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });

    try {
      await launchPersistentCamoufox({
        userDataDir: "/profile",
        headless: true,
      });

      expect(displayGetMock).not.toHaveBeenCalled();
      expect(launchOptionsMock).toHaveBeenCalledWith(
        expect.objectContaining({ headless: false }),
      );
      expect(launchOptionsMock.mock.calls[0]?.[0]).not.toHaveProperty(
        "virtual_display",
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("closes the context when page setup rejects", async () => {
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });

    await expect(
      withPersistentCamoufoxContext(
        { userDataDir: "/profile", headless: false },
        async () => {
          throw new Error("page setup failed");
        },
      ),
    ).rejects.toThrow("page setup failed");
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("preserves a setup failure when sanitized cleanup also fails", async () => {
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });
    closeMock.mockRejectedValue(new Error("private close diagnostics"));

    let thrown: unknown;
    try {
      await withPersistentCamoufoxContext(
        { userDataDir: "/profile", headless: false },
        async () => {
          throw new Error("page setup failed");
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toBe(
      "page setup failed Browser cleanup also failed closed.",
    );
    expect(aggregate.errors[0]).toMatchObject({ message: "page setup failed" });
    expect(aggregate.errors[1]).toMatchObject({
      message: "Camoufox context cleanup failed.",
    });
    expect(JSON.stringify(aggregate.errors[1])).not.toContain("private");
  });

  it("requests a hard task stop when context cleanup exceeds its deadline", async () => {
    launchOptionsMock.mockResolvedValue({
      env: { CAMOU_CONFIG_1: '{"navigator.userAgent":"stable"}' },
    });
    closeMock.mockReturnValue(new Promise<void>(() => undefined));
    const terminateProcess = vi.fn((message: string): never => {
      throw new Error(`terminated: ${message}`);
    });

    await expect(
      withPersistentCamoufoxContext(
        { userDataDir: "/profile", headless: false },
        async () => "complete",
        { cleanupTimeoutMs: 1, terminateProcess },
      ),
    ).rejects.toThrow("Camoufox context cleanup failed.");
    expect(terminateProcess).toHaveBeenCalledWith(
      "Camoufox context cleanup timed out; terminating task.",
    );
  });
});
