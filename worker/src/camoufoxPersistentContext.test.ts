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

beforeEach(() => {
  vi.clearAllMocks();
  displayGetMock.mockReturnValue(":41");
  closeMock.mockResolvedValue(undefined);
  launchPersistentMock.mockResolvedValue({ close: closeMock });
});

describe("persistent Camoufox launch", () => {
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
});
