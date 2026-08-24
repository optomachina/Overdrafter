import { describe, expect, it, vi } from "vitest";
import {
  buildXometryAuthProbeEvidence,
  buildXometryAuthProbeFailureEvidence,
  buildXometryAuthProbeEvidenceFromBounded,
  classifyXometryAuthProbe,
  classifyXometryAuthProbeFailureStage,
  isReadOnlyProbeRequest,
  isSupportedXometryAuthProbeEngine,
  requireAuthenticatedXometryColdRelaunch,
  requireAuthenticatedXometryDashboard,
  withClosingXometryAuthProbeContext,
  XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
  XOMETRY_AUTH_PROBE_PLAYWRIGHT_CONTEXT_GUARDS,
} from "./xometryAuthProbe.js";
import type { BrowserContext } from "playwright";

function fakeProbeContext(input: {
  url?: string;
  bodyText: string | (() => string);
  dashboardUploadButtonVisible?: boolean;
  bodyTextError?: Error;
  networkIdleError?: Error;
  routeSetupError?: Error;
  webSocketSetupError?: Error;
  transportGuardVerificationFails?: boolean;
  newPageFailsAfterLastRestoredPageCloses?: boolean;
  offlineIsolationError?: Error;
  offlineIsolationHangs?: boolean;
  closeError?: Error;
  closeHangs?: boolean;
  requests?: Array<{
    method: string;
    url: string;
    postData?: string | null;
  }>;
}) {
  const events = {
    closed: false,
    routePattern: "",
    webSocketPattern: "",
    navigatedTo: "",
    continuedMethods: [] as string[],
    abortedMethods: [] as string[],
    webSocketClosed: false,
    restoredPagesClosed: 0,
    workerGuardInstalled: false,
    peerTransportGuardInstalled: false,
    transportGuardsVerified: false,
    setupOrder: [] as string[],
    offlineTransitions: [] as boolean[],
  };
  let routeHandler:
    | ((route: {
        request: () => {
          method: () => string;
          url: () => string;
          postData: () => string | null;
        };
        continue: () => Promise<void>;
        abort: (errorCode: string) => Promise<void>;
      }) => Promise<void>)
    | null = null;
  let webSocketHandler: ((route: { close: () => void }) => void) | null = null;
  let openRestoredPages = 1;
  const pageUrl = input.url ?? "https://www.xometry.com/quoting/home/";
  const context = {
    pages: () => [
      {
        close: async () => {
          events.setupOrder.push("close-restored-page");
          events.restoredPagesClosed += 1;
          openRestoredPages -= 1;
        },
      },
    ],
    addInitScript: async (script: string) => {
      events.setupOrder.push("worker-network-guard");
      events.workerGuardInstalled =
        script.includes('"Worker"') &&
        script.includes('"SharedWorker"') &&
        script.includes('"WebSocket"');
      events.peerTransportGuardInstalled =
        script.includes('"RTCPeerConnection"') &&
        script.includes('"webkitRTCPeerConnection"') &&
        script.includes('"WebTransport"');
    },
    route: async (pattern: string, handler: typeof routeHandler) => {
      events.setupOrder.push("http-route");
      if (input.routeSetupError) throw input.routeSetupError;
      events.routePattern = pattern;
      routeHandler = handler;
    },
    routeWebSocket: async (
      pattern: string,
      handler: typeof webSocketHandler,
    ) => {
      events.setupOrder.push("websocket-route");
      if (input.webSocketSetupError) throw input.webSocketSetupError;
      events.webSocketPattern = pattern;
      webSocketHandler = handler;
    },
    setOffline: async (offline: boolean) => {
      events.setupOrder.push(offline ? "set-offline" : "set-online");
      events.offlineTransitions.push(offline);
      if (offline && input.offlineIsolationError) {
        throw input.offlineIsolationError;
      }
      if (offline && input.offlineIsolationHangs) {
        await new Promise<void>(() => undefined);
      }
    },
    newPage: async () => {
      events.setupOrder.push("create-guarded-page");
      if (
        input.newPageFailsAfterLastRestoredPageCloses &&
        openRestoredPages === 0
      ) {
        throw new Error("persistent context lost its last page");
      }
      return {
        evaluate: async () => {
          events.setupOrder.push("verify-page-transport-guards");
          events.transportGuardsVerified = true;
          return !input.transportGuardVerificationFails;
        },
        goto: async (url: string) => {
          events.setupOrder.push("navigate");
          events.navigatedTo = url;
          for (const request of input.requests ?? []) {
            if (!routeHandler)
              throw new Error("route handler was not installed");
            await routeHandler({
              request: () => ({
                method: () => request.method,
                url: () => request.url,
                postData: () => request.postData ?? null,
              }),
              continue: async () => {
                events.continuedMethods.push(request.method);
              },
              abort: async (errorCode: string) => {
                expect(errorCode).toBe("blockedbyclient");
                events.abortedMethods.push(request.method);
              },
            });
          }
          if (!webSocketHandler) {
            throw new Error("WebSocket handler was not installed");
          }
          webSocketHandler({
            close: () => {
              events.webSocketClosed = true;
            },
          });
        },
        waitForLoadState: async () => {
          if (input.networkIdleError) throw input.networkIdleError;
        },
        locator: (selector: string) => {
          if (selector === "body") {
            return {
              innerText: async () => {
                if (input.bodyTextError) throw input.bodyTextError;
                return typeof input.bodyText === "function"
                  ? input.bodyText()
                  : input.bodyText;
              },
            };
          }
          return {
            first: () => ({
              isVisible: async () =>
                input.dashboardUploadButtonVisible ?? false,
            }),
          };
        },
        waitForTimeout: async () => undefined,
        url: () => pageUrl,
      };
    },
    close: async () => {
      events.setupOrder.push("close");
      events.closed = true;
      if (input.closeError) throw input.closeError;
      if (input.closeHangs) await new Promise<void>(() => undefined);
    },
  } as unknown as BrowserContext;
  return { context, events };
}

describe("Xometry authentication probe", () => {
  it("supports the production persistent-context engines", () => {
    expect(isSupportedXometryAuthProbeEngine("playwright")).toBe(true);
    expect(isSupportedXometryAuthProbeEngine("camoufox")).toBe(true);
    expect(isSupportedXometryAuthProbeEngine("patchright")).toBe(false);
  });

  it("disables Camoufox service workers before a restored profile starts", () => {
    expect(XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS).toEqual({
      offline: true,
      serviceWorkers: "block",
      firefox_user_prefs: {
        "dom.serviceWorkers.enabled": false,
        "media.peerconnection.enabled": false,
        "network.webtransport.enabled": false,
      },
    });
    expect(XOMETRY_AUTH_PROBE_PLAYWRIGHT_CONTEXT_GUARDS).toEqual({
      offline: true,
      serviceWorkers: "block",
    });
  });

  it("accepts authenticated dashboard text without requiring an interaction", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/quoting/home/",
        bodyText: "Welcome back. Recent quotes",
        dashboardUploadButtonVisible: false,
      }),
    ).toEqual({ authenticated: true, reason: "authenticated_dashboard" });
  });

  it("accepts the current account quote-list dashboard without an interaction", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/quoting/home/",
        bodyText:
          "My Account Personal Quotes Orders Tools Part Library Export CSV",
        dashboardUploadButtonVisible: false,
      }),
    ).toEqual({ authenticated: true, reason: "authenticated_dashboard" });
  });

  it("does not accept the account label without the quote-list signal", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/quoting/home/",
        bodyText: "My Account",
        dashboardUploadButtonVisible: false,
      }),
    ).toEqual({
      authenticated: false,
      reason: "authenticated_dashboard_not_confirmed",
    });
  });

  it("does not accept the upload button as standalone authentication proof", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/quoting/home/",
        bodyText: "Instant quoting",
        dashboardUploadButtonVisible: true,
      }),
    ).toEqual({
      authenticated: false,
      reason: "authenticated_dashboard_not_confirmed",
    });
  });

  it.each([
    ["Sign in to continue", "https://www.xometry.com/login/", "login_required"],
    [
      "Upload a 3D model to see instant pricing, lead time, and DFM feedback. Already have an account?",
      "https://www.xometry.com/quoting/home/",
      "anonymous_quote_home",
    ],
    [
      "Verify you are human",
      "https://www.xometry.com/quoting/home/",
      "captcha",
    ],
    [
      "Access denied",
      "https://www.xometry.com/quoting/home/",
      "provider_error",
    ],
  ])("fails closed for %s", (bodyText, url, reason) => {
    expect(
      classifyXometryAuthProbe({
        url,
        bodyText,
        dashboardUploadButtonVisible: true,
      }),
    ).toEqual({ authenticated: false, reason });
  });

  it("does not accept a positive signal away from the quote dashboard", () => {
    expect(
      classifyXometryAuthProbe({
        url: "https://www.xometry.com/",
        bodyText: "Welcome back",
        dashboardUploadButtonVisible: true,
      }),
    ).toEqual({
      authenticated: false,
      reason: "authenticated_dashboard_not_confirmed",
    });
  });

  it("confirms a positive cold relaunch using bounded read-only navigation", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "Welcome back. Recent quotes",
      requests: [
        {
          method: "GET",
          url: "https://www.xometry.com/quoting/home/",
        },
        {
          method: "POST",
          url: "https://www.xometry.com/api/graphql/",
          postData: JSON.stringify({ query: "query Viewer { viewer { id } }" }),
        },
        {
          method: "POST",
          url: "https://www.xometry.com/api/graphql/",
          postData: JSON.stringify({ query: "mutation Upload { uploadPart }" }),
        },
        {
          method: "POST",
          url: "https://example.com/api/graphql/",
          postData: JSON.stringify({ query: "query Viewer { viewer { id } }" }),
        },
      ],
    });

    const evidence = await requireAuthenticatedXometryColdRelaunch({
      launchContext: async () => context,
    });

    expect(evidence).toMatchObject({
      authenticated: true,
      reason: "authenticated_dashboard",
      url: "https://www.xometry.com/quoting/home/",
      blockedNonReadMethods: ["POST"],
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
    });
    expect(events.closed).toBe(true);
    expect(events.routePattern).toBe("**/*");
    expect(events.webSocketPattern).toBe("**/*");
    expect(events.navigatedTo).toBe("https://www.xometry.com/quoting/home/");
    expect(events.continuedMethods).toEqual(["GET", "POST"]);
    expect(events.abortedMethods).toEqual(["POST", "POST"]);
    expect(events.webSocketClosed).toBe(true);
    expect(events.restoredPagesClosed).toBe(1);
    expect(events.workerGuardInstalled).toBe(true);
    expect(events.peerTransportGuardInstalled).toBe(true);
    expect(events.transportGuardsVerified).toBe(true);
    expect(events.setupOrder.slice(0, 8)).toEqual([
      "worker-network-guard",
      "http-route",
      "websocket-route",
      "create-guarded-page",
      "verify-page-transport-guards",
      "close-restored-page",
      "set-online",
      "navigate",
    ]);
    expect(events.offlineTransitions).toEqual([false, true]);
    expect(events.setupOrder.at(-2)).toBe("set-offline");
    expect(events.setupOrder.at(-1)).toBe("close");
  });

  it("keeps a restored page alive until the guarded page is verified", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "Welcome back. Recent quotes",
      newPageFailsAfterLastRestoredPageCloses: true,
    });

    await expect(
      requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      }),
    ).resolves.toMatchObject({
      authenticated: true,
      reason: "authenticated_dashboard",
    });
    expect(events.setupOrder.slice(0, 8)).toEqual([
      "worker-network-guard",
      "http-route",
      "websocket-route",
      "create-guarded-page",
      "verify-page-transport-guards",
      "close-restored-page",
      "set-online",
      "navigate",
    ]);
  });

  it("inspects a rendered dashboard when background polling prevents network idle", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "Welcome back. Recent quotes",
      networkIdleError: new Error("network idle timed out"),
    });

    await expect(
      requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      }),
    ).resolves.toMatchObject({
      authenticated: true,
      reason: "authenticated_dashboard",
    });
    expect(events.closed).toBe(true);
  });

  it("waits for the dashboard to replace transient login shell copy", async () => {
    let reads = 0;
    const { context } = fakeProbeContext({
      bodyText: () => {
        reads += 1;
        return reads < 3
          ? "Log In / Register"
          : "My Account Personal Quotes Orders Tools Part Library Export CSV";
      },
    });

    await expect(
      requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      }),
    ).resolves.toMatchObject({
      authenticated: true,
      reason: "authenticated_dashboard",
    });
    expect(reads).toBe(3);
  });

  it.each([
    ["Sign in to continue", "https://www.xometry.com/login/", "login_required"],
    [
      "unrecognized private shell",
      "https://www.xometry.com/quoting/home/",
      "authenticated_dashboard_not_confirmed",
    ],
  ])(
    "fails closed and closes the cold-relaunch context for %s",
    async (bodyText, url, reason) => {
      const { context, events } = fakeProbeContext({ bodyText, url });

      await expect(
        requireAuthenticatedXometryColdRelaunch({
          launchContext: async () => context,
        }),
      ).rejects.toThrow(
        `Xometry cold-relaunch authentication was not confirmed: ${reason}.`,
      );
      expect(events.closed).toBe(true);
      expect(events.offlineTransitions).toEqual([false, true]);
      expect(events.setupOrder.at(-2)).toBe("set-offline");
      expect(events.setupOrder.at(-1)).toBe("close");
    },
  );

  it("closes the cold-relaunch context when bounded DOM inspection throws", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "unused",
      bodyTextError: new Error("synthetic DOM failure"),
    });

    await expect(
      requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      }),
    ).rejects.toThrow(
      "Xometry authentication probe navigation or inspection failed.",
    );
    expect(events.closed).toBe(true);
    expect(events.offlineTransitions).toEqual([false, true]);
  });

  it("closes while still offline when probe guard installation fails", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "unused",
      webSocketSetupError: new Error("synthetic guard setup failure"),
    });

    await expect(
      requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      }),
    ).rejects.toThrow("Xometry authentication probe guard setup failed.");
    await expect(
      requireAuthenticatedXometryColdRelaunch({
        launchContext: async () =>
          fakeProbeContext({
            bodyText: "unused",
            routeSetupError: new Error("private route diagnostics"),
          }).context,
      }),
    ).rejects.not.toThrow("private route diagnostics");
    expect(events.closed).toBe(true);
    expect(events.setupOrder).toEqual([
      "worker-network-guard",
      "http-route",
      "websocket-route",
      "set-offline",
      "close",
    ]);
    expect(events.offlineTransitions).toEqual([true]);
  });

  it("closes while still offline when page transport guards cannot be verified", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "unused",
      transportGuardVerificationFails: true,
    });

    await expect(
      requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      }),
    ).rejects.toThrow(
      "Xometry authentication probe guard verification failed.",
    );
    expect(events.closed).toBe(true);
    expect(events.setupOrder).toEqual([
      "worker-network-guard",
      "http-route",
      "websocket-route",
      "create-guarded-page",
      "verify-page-transport-guards",
      "set-offline",
      "close",
    ]);
    expect(events.offlineTransitions).toEqual([true]);
  });

  it("preserves the primary auth failure when context cleanup also fails", async () => {
    const cleanupError = new Error("private cleanup diagnostics");
    const { context, events } = fakeProbeContext({
      bodyText: "Sign in to continue",
      url: "https://www.xometry.com/login/",
      closeError: cleanupError,
    });

    let thrown: unknown;
    try {
      await requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toBe(
      "Xometry cold-relaunch authentication was not confirmed: login_required. Probe cleanup also failed closed.",
    );
    expect(aggregate.message).not.toContain("private cleanup diagnostics");
    expect(aggregate.errors[0]).toMatchObject({
      message:
        "Xometry cold-relaunch authentication was not confirmed: login_required.",
    });
    expect(aggregate.errors[1]).toMatchObject({
      message: "Xometry authentication probe context cleanup failed.",
    });
    expect(JSON.stringify(aggregate.errors[1])).not.toContain(
      "private cleanup diagnostics",
    );
    expect(events.offlineTransitions).toEqual([false, true]);
    expect(events.setupOrder.at(-2)).toBe("set-offline");
    expect(events.setupOrder.at(-1)).toBe("close");
  });

  it("preserves the primary auth failure when re-isolation and close also fail", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "Sign in to continue",
      url: "https://www.xometry.com/login/",
      offlineIsolationError: new Error("private isolation diagnostics"),
      closeError: new Error("private close diagnostics"),
    });

    let thrown: unknown;
    try {
      await requireAuthenticatedXometryColdRelaunch({
        launchContext: async () => context,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toBe(
      "Xometry cold-relaunch authentication was not confirmed: login_required. Probe cleanup also failed closed.",
    );
    expect(aggregate.errors).toHaveLength(3);
    expect(aggregate.errors[1]).toMatchObject({
      message: "Xometry authentication probe network re-isolation failed.",
    });
    expect(aggregate.errors[2]).toMatchObject({
      message: "Xometry authentication probe context cleanup failed.",
    });
    expect(JSON.stringify(aggregate.errors.slice(1))).not.toContain("private");
    expect(events.offlineTransitions).toEqual([false, true]);
    expect(events.setupOrder.at(-2)).toBe("set-offline");
    expect(events.setupOrder.at(-1)).toBe("close");
  });

  it.each([
    ["network re-isolation", { offlineIsolationHangs: true }],
    ["context cleanup", { closeHangs: true }],
  ])(
    "requests a hard task stop when %s exceeds its deadline",
    async (_label, failure) => {
      const { context } = fakeProbeContext({
        bodyText: "Welcome back. Recent quotes",
        ...failure,
      });
      const terminateProcess = vi.fn((message: string): never => {
        throw new Error(`terminated: ${message}`);
      });

      await expect(
        withClosingXometryAuthProbeContext(context, async () => "complete", {
          cleanupTimeoutMs: 1,
          terminateProcess,
        }),
      ).rejects.toThrow("Xometry authentication probe");
      expect(terminateProcess).toHaveBeenCalledOnce();
      expect(terminateProcess.mock.calls[0]?.[0]).not.toContain("private");
    },
  );

  it("requests a hard task stop when the guarded probe operation hangs", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "Welcome back. Recent quotes",
    });
    const terminateProcess = vi.fn((message: string): never => {
      throw new Error(`terminated: ${message}`);
    });

    await expect(
      withClosingXometryAuthProbeContext(
        context,
        async () => new Promise<never>(() => undefined),
        { operationTimeoutMs: 1, terminateProcess },
      ),
    ).rejects.toThrow("operation timed out");
    expect(terminateProcess).toHaveBeenCalledOnce();
    expect(events.offlineTransitions).toEqual([true]);
    expect(events.closed).toBe(true);
  });

  it.each([
    ["unrecognized shell", "authenticated_dashboard_not_confirmed"],
    [
      "Upload a 3D model to see instant pricing, lead time, and DFM feedback. Already have an account?",
      "anonymous_quote_home",
    ],
  ])(
    "refuses bootstrap for an unverified dashboard: %s",
    (bodyText, reason) => {
      expect(() =>
        requireAuthenticatedXometryDashboard({
          url: "https://www.xometry.com/quoting/home/",
          bodyText,
          dashboardUploadButtonVisible: false,
        }),
      ).toThrow(`Xometry authentication was not confirmed: ${reason}.`);
    },
  );

  it("returns bounded failure evidence without page text, query data, or fragments", () => {
    const evidence = buildXometryAuthProbeEvidence({
      url: "https://www.xometry.com/unexpected/path?account=private#secret",
      bodyText: "unrecognized private page content",
      dashboardUploadButtonVisible: false,
      snapshotGeneration: "41",
      browserEngine: "camoufox",
      blockedNonReadMethods: ["POST", "DELETE", "X-PRIVATE-ID"],
    });

    expect(evidence).toEqual({
      authenticated: false,
      reason: "authenticated_dashboard_not_confirmed",
      url: "xometry_redirect",
      snapshotGeneration: "41",
      browserEngine: "camoufox",
      blockedNonReadMethods: ["DELETE", "OTHER", "POST"],
      dashboardUploadButtonVisible: false,
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
      snapshotPersisted: false,
    });
    expect(JSON.stringify(evidence)).not.toContain("private page content");
    expect(JSON.stringify(evidence)).not.toContain("account=private");
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(JSON.stringify(evidence)).not.toContain("unexpected/path");
    expect(JSON.stringify(evidence)).not.toContain("X-PRIVATE-ID");
  });

  it("returns one stable generic failure without low-level diagnostics", () => {
    const failure = buildXometryAuthProbeFailureEvidence();
    expect(failure).toEqual({
      authenticated: false,
      reason: "probe_failed",
      failureStage: "unknown",
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
      snapshotPersisted: false,
    });
    expect(JSON.stringify(failure)).not.toContain("path");
  });

  it("reports only an allowlisted failure stage without leaking diagnostics", () => {
    const privateError = new Error("private snapshot path and account details");
    const classified = classifyXometryAuthProbeFailureStage(
      new AggregateError(
        [
          new Error("Xometry authentication probe navigation or inspection failed."),
          privateError,
        ],
        "private aggregate details",
      ),
      "bounded_probe",
    );
    const failure = buildXometryAuthProbeFailureEvidence(classified);

    expect(failure.failureStage).toBe("navigation_or_inspection");
    expect(JSON.stringify(failure)).not.toContain("private");
    expect(
      classifyXometryAuthProbeFailureStage(privateError, "snapshot_restore"),
    ).toBe("snapshot_restore");
  });

  it.each([
    [
      "accessor",
      () => {
        const error = new AggregateError([], "private aggregate details");
        Object.defineProperty(error, "errors", {
          get() {
            throw new Error("private errors accessor diagnostics");
          },
        });
        return error;
      },
    ],
    [
      "iterator",
      () => {
        const error = new AggregateError([], "private aggregate details");
        Object.defineProperty(error, "errors", {
          value: {
            [Symbol.iterator]() {
              throw new Error("private errors iterator diagnostics");
            },
          },
        });
        return error;
      },
    ],
  ])(
    "contains a throwing AggregateError errors %s in the generic failure envelope",
    (_kind, malformedError) => {
      const failure = buildXometryAuthProbeFailureEvidence(
        classifyXometryAuthProbeFailureStage(
          malformedError(),
          "bounded_probe",
        ),
      );

      expect(failure).toEqual({
        authenticated: false,
        reason: "probe_failed",
        failureStage: "bounded_probe",
        fileSelectionPerformed: false,
        userInputInteractionPerformed: false,
        snapshotPersisted: false,
      });
      expect(JSON.stringify(failure)).not.toContain("private");
    },
  );

  it("adds hosted snapshot metadata and re-sanitizes bounded evidence", () => {
    const evidence = buildXometryAuthProbeEvidenceFromBounded({
      evidence: {
        authenticated: true,
        reason: "authenticated_dashboard",
        url: "https://private-account.xometry.com/private/path?secret=value",
        blockedNonReadMethods: ["POST"],
        dashboardUploadButtonVisible: true,
        fileSelectionPerformed: false,
        userInputInteractionPerformed: false,
      },
      snapshotGeneration: "52",
      browserEngine: "camoufox",
    });

    expect(evidence).toEqual({
      authenticated: true,
      reason: "authenticated_dashboard",
      url: "xometry_redirect",
      snapshotGeneration: "52",
      browserEngine: "camoufox",
      blockedNonReadMethods: ["POST"],
      dashboardUploadButtonVisible: true,
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
      snapshotPersisted: false,
    });
    expect(JSON.stringify(evidence)).not.toContain("private-account");
    expect(JSON.stringify(evidence)).not.toContain("secret=value");
  });

  it("preserves an already-sanitized bounded redirect category", () => {
    const evidence = buildXometryAuthProbeEvidenceFromBounded({
      evidence: {
        authenticated: false,
        reason: "authenticated_dashboard_not_confirmed",
        url: "xometry_redirect",
        blockedNonReadMethods: [],
        dashboardUploadButtonVisible: false,
        fileSelectionPerformed: false,
        userInputInteractionPerformed: false,
      },
      snapshotGeneration: "53",
      browserEngine: "camoufox",
    });

    expect(evidence.url).toBe("xometry_redirect");
  });

  it("allows reads and Xometry query-only GraphQL requests", () => {
    const request = (
      method: string,
      url = "https://example.com",
      postData: string | null = null,
    ) => isReadOnlyProbeRequest({ method, url, postData });

    expect(request("GET", "https://www.xometry.com/quoting/home/")).toBe(true);
    expect(request("head", "https://assets.xometry.com/app.js")).toBe(true);
    expect(request("OPTIONS", "https://xometry.com/api/status")).toBe(true);
    expect(
      request(
        "POST",
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({ query: "query Viewer { viewer { id } }" }),
      ),
    ).toBe(true);
    expect(
      request(
        "POST",
        "https://www.xometry.com/graphql/federation/buyer",
        JSON.stringify([{ query: "{ viewer { id } }" }]),
      ),
    ).toBe(true);
  });

  it("blocks mutations and non-allowlisted POST requests", () => {
    const request = (url: string, postData: string | null) =>
      isReadOnlyProbeRequest({ method: "POST", url, postData });

    expect(
      request(
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({ query: "mutation Upload { uploadPart }" }),
      ),
    ).toBe(false);
    expect(
      request(
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({
          query:
            "query Viewer { viewer { id } } mutation Upload { uploadPart }",
          operationName: "Upload",
        }),
      ),
    ).toBe(false);
    expect(
      request(
        "https://www.xometry.com/api/graphql/",
        JSON.stringify({
          query: "subscription Updates { quoteUpdated { id } }",
        }),
      ),
    ).toBe(false);
    expect(
      request(
        "https://example.com/api/graphql/",
        JSON.stringify({ query: "query Viewer { viewer { id } }" }),
      ),
    ).toBe(false);
    expect(request("https://www.xometry.com/api/graphql/", null)).toBe(false);
    expect(request("https://www.xometry.com/api/graphql/", "not-json")).toBe(
      false,
    );
    expect(
      isReadOnlyProbeRequest({
        method: "PUT",
        url: "https://www.xometry.com",
        postData: null,
      }),
    ).toBe(false);
    expect(
      isReadOnlyProbeRequest({
        method: "GET",
        url: "https://example.com/tracker",
        postData: null,
      }),
    ).toBe(false);
    expect(
      isReadOnlyProbeRequest({
        method: "GET",
        url: "http://www.xometry.com/insecure",
        postData: null,
      }),
    ).toBe(false);
    expect(
      isReadOnlyProbeRequest({
        method: "GET",
        url: "not-a-url",
        postData: null,
      }),
    ).toBe(false);
  });
});
