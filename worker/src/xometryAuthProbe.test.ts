import { XometryProfileSnapshotError } from "./xometryProfileSnapshot";
import { VendorAutomationError } from "./types";
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
  runBoundedXometryAuthProbe,
  withClosingXometryAuthProbeContext,
  XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS,
  XOMETRY_AUTH_PROBE_PLAYWRIGHT_CONTEXT_GUARDS,
  xometryRouteClass,
} from "./xometryAuthProbe.js";
import type { PageFingerprint } from "./fixtureHeal/fingerprint.js";
import type { BrowserContext } from "playwright";
import anonymousQuoteHome from "./adapters/fixtures/xometry-anonymous-quote-home.json";

function fakeProbeContext(input: {
  url?: string;
  bodyText: string | (() => string);
  dashboardUploadButtonVisible?: boolean;
  bodyTextError?: Error;
  gotoError?: unknown;
  networkIdleError?: Error;
  routeSetupError?: Error;
  webSocketSetupError?: Error;
  transportGuardVerificationFails?: boolean;
  newPageFailsAfterLastRestoredPageCloses?: boolean;
  offlineIsolationError?: Error;
  offlineIsolationHangs?: boolean;
  closeError?: Error;
  closeHangs?: boolean;
  domStructure?: unknown;
  domStructureError?: Error;
  domStructureHangs?: boolean;
  selectorCounts?: Record<string, number>;
  urlAfterStructureWalk?: string;
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
  let pageUrl = input.url ?? "https://www.xometry.com/quoting/home/";
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
        evaluate: async (script: unknown) => {
          if (typeof script === "string") {
            events.setupOrder.push("collect-page-structure");
            if (input.urlAfterStructureWalk) pageUrl = input.urlAfterStructureWalk;
            if (input.domStructureError) throw input.domStructureError;
            if (input.domStructureHangs) await new Promise<void>(() => undefined);
            return input.domStructure ?? null;
          }
          events.setupOrder.push("verify-page-transport-guards");
          events.transportGuardsVerified = true;
          return !input.transportGuardVerificationFails;
        },
        goto: async (url: string) => {
          events.setupOrder.push("navigate");
          events.navigatedTo = url;
          if (input.gotoError !== undefined) throw input.gotoError;
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
            count: async () => input.selectorCounts?.[selector] ?? 0,
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
    ["", "anonymous_quote_home"],
    [anonymousQuoteHome.errorBanner, "anonymous_quote_home"],
    ["My Account", "anonymous_quote_home"],
    ["Welcome back. Recent quotes", "authenticated_dashboard"],
    ["My Account Part Library", "authenticated_dashboard"],
    ["Sign in", "login_required"],
    ["Sign in Verify you are human", "captcha"],
    [`Welcome back ${anonymousQuoteHome.errorBanner}`, "provider_error"],
    ["Welcome back Already have an account?", "anonymous_quote_home"],
  ])("classifies the upload prompt with %s as %s", (extra, reason) => {
    expect(classifyXometryAuthProbe({
      url: "https://www.xometry.com/quoting/home/",
      bodyText: `${anonymousQuoteHome.uploadPrompt} ${anonymousQuoteHome.uploadButton} ${extra}`,
      dashboardUploadButtonVisible: true,
    })).toEqual({ authenticated: reason === "authenticated_dashboard", reason });
  });

  it("does not classify the upload prompt away from quote home as anonymous", () => {
    expect(classifyXometryAuthProbe({
      url: "https://www.xometry.com/resources/",
      bodyText: anonymousQuoteHome.uploadPrompt,
      dashboardUploadButtonVisible: true,
    })).toEqual({ authenticated: false, reason: "authenticated_dashboard_not_confirmed" });
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

  it("runs the live precondition after browser guards and immediately before networking", async () => {
    const { context, events } = fakeProbeContext({
      bodyText: "Welcome back. Recent quotes",
    });

    await runBoundedXometryAuthProbe(context, {
      beforeNetworkActivation: async () => {
        events.setupOrder.push("live-precondition");
      },
    });

    expect(events.setupOrder.slice(0, 8)).toEqual([
      "worker-network-guard",
      "http-route",
      "websocket-route",
      "create-guarded-page",
      "verify-page-transport-guards",
      "close-restored-page",
      "live-precondition",
      "set-online",
    ]);
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

  const syntheticUrl = "https://www.xometry.com/quoting/home/?session=synthetic-secret";
  const callLog = `\nCall log:\n  - navigating to "${syntheticUrl}", waiting until "domcontentloaded"`;
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it.each([
    ["timeout", named("TimeoutError", `page.goto: Timeout 30000ms exceeded.${callLog}`)],
    ["timeout", new Error(`page.goto: Timeout 30000ms exceeded.${callLog}`)],
    ["navigation_aborted", new Error(`page.goto: net::ERR_ABORTED at ${syntheticUrl}${callLog}`)],
    ["navigation_aborted", new Error(`page.goto: NS_BINDING_ABORTED${callLog}`)],
    ["navigation_aborted", new Error(`page.goto: Navigation to "${syntheticUrl}" is interrupted by another navigation to "https://www.xometry.com/login?next=synthetic"`)],
    ["context_destroyed", new Error("page.goto: Execution context was destroyed, most likely because of a navigation")],
    ["context_destroyed", new Error("page.goto: Target page, context or browser has been closed")],
    ["net_error", new Error(`page.goto: net::ERR_NAME_NOT_RESOLVED at ${syntheticUrl}${callLog}`)],
    ["net_error", new Error(`page.goto: NS_ERROR_NET_TIMEOUT${callLog}`)],
    ["net_error", new Error(`page.goto: net::ERR_CONNECTION_RESET at ${syntheticUrl}\nCall log:\n  - Timeout 30000ms exceeded`)],
    ["other", new Error("<html>synthetic provider error body</html>")],
    ["other", "synthetic thrown string"],
  ])("reports a goto %s failure in the cold-relaunch line and failure evidence", async (cause, gotoError) => {
    const { context, events } = fakeProbeContext({ bodyText: "unused", gotoError });
    const thrown = await requireAuthenticatedXometryColdRelaunch({ launchContext: async () => context })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    const line = (thrown as Error).message;
    expect(line).toBe(`Xometry authentication probe navigation or inspection failed. subStage=goto cause=${cause}.`);
    expect((thrown as Error).cause).toBeUndefined();
    const evidence = buildXometryAuthProbeFailureEvidence(
      classifyXometryAuthProbeFailureStage(thrown, "bounded_probe"),
      thrown,
    );
    expect(evidence).toEqual({
      authenticated: false,
      reason: "probe_failed",
      failureStage: "navigation_or_inspection",
      navigationOrInspection: { subStage: "goto", cause },
      fileSelectionPerformed: false,
      userInputInteractionPerformed: false,
      snapshotPersisted: false,
    });
    expect(`${line} ${JSON.stringify(evidence)}`).not.toMatch(/synthetic|https?:|\?|Call log|html/);
    expect(events.closed).toBe(true);
  });

  it("names the inspection sub-stage and keeps it when cleanup also fails", async () => {
    const { context } = fakeProbeContext({
      bodyText: "unused",
      bodyTextError: new Error("locator.innerText: Execution context was destroyed, most likely because of a navigation"),
      closeError: new Error("synthetic close diagnostics"),
    });
    const thrown = await requireAuthenticatedXometryColdRelaunch({ launchContext: async () => context })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toBe(
      "Xometry authentication probe navigation or inspection failed. subStage=inspection cause=context_destroyed. Probe cleanup also failed closed.",
    );
    expect(
      buildXometryAuthProbeFailureEvidence(classifyXometryAuthProbeFailureStage(thrown), thrown)
        .navigationOrInspection,
    ).toEqual({ subStage: "inspection", cause: "context_destroyed" });
  });

  it("names the fingerprint sub-stage for a failure after classification", async () => {
    // Drift capture is fail-soft, so a throwing option accessor stands in for a defect in that tail.
    const { context } = fakeProbeContext({ bodyText: "Synthetic page without dashboard signals" });
    await expect(
      runBoundedXometryAuthProbe(context, {
        get onDashboardNotConfirmed(): (fingerprint: PageFingerprint | null) => void {
          throw named("TimeoutError", "synthetic accessor failure");
        },
      }),
    ).rejects.toThrow(
      /^Xometry authentication probe navigation or inspection failed\. subStage=fingerprint cause=timeout\.$/,
    );
  });

  it("omits the navigation detail when the fixed message does not carry one", () => {
    const evidence = buildXometryAuthProbeFailureEvidence(
      "navigation_or_inspection",
      new Error("Xometry authentication probe navigation or inspection failed. subStage=private cause=private."),
    );
    expect(evidence).not.toHaveProperty("navigationOrInspection");
    expect(
      buildXometryAuthProbeFailureEvidence(
        "operation_timeout",
        new Error("Xometry authentication probe navigation or inspection failed. subStage=goto cause=timeout."),
      ),
    ).not.toHaveProperty("navigationOrInspection");
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
      screenshotCaptured: false,
      domCaptured: false,
      traceCaptured: false,
      providerMutationObserved: false,
      dashboardInteraction: "read_only_authentication",
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
          new Error(
            "Xometry authentication probe navigation or inspection failed.",
          ),
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
        classifyXometryAuthProbeFailureStage(malformedError(), "bounded_probe"),
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
      screenshotCaptured: false,
      domCaptured: false,
      traceCaptured: false,
      providerMutationObserved: false,
      dashboardInteraction: "read_only_authentication",
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


describe("drift fingerprint on authenticated_dashboard_not_confirmed", () => {
  const privatePage = {
    bodyText: "Your quotes · Jordan Okafor · jordan@example.com · Q24-1234-5678 · $252.97",
    domStructure: {
      landmarks: { banner: 1, navigation: 1, main: 1, dialog: 0 },
      headings: ["Your quotes", "Welcome, Jordan Okafor"],
      buttons: ["New quote", "Q24-1234-5678", "jordan@example.com"],
      links: ["Orders", "Account settings for Jordan"],
      testIds: ["QuoteListView-new-quote", "quote-row-Q24-1234-5678"],
    },
    selectorCounts: { 'button:has-text("Start a New")': 1 },
  };

  it("hands over one scrubbed fingerprint and leaves the evidence unchanged", async () => {
    const seen: Array<PageFingerprint | null> = [];
    const withCallback = fakeProbeContext(privatePage);
    const evidence = await runBoundedXometryAuthProbe(withCallback.context, {
      onDashboardNotConfirmed: (fingerprint) => seen.push(fingerprint),
    });
    const plain = await runBoundedXometryAuthProbe(fakeProbeContext(privatePage).context);

    expect(evidence).toEqual(plain);
    expect(evidence).toMatchObject({ authenticated: false, reason: "authenticated_dashboard_not_confirmed" });
    expect(Object.keys(evidence)).not.toContain("fingerprint");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      provider: "xometry",
      page: "upload",
      source: "session_probe",
      routeClass: "quote_home",
      headings: { count: 2, labels: ["your quotes"] },
      buttons: { count: 3, labels: ["new quote"] },
      links: { count: 2, labels: ["orders"] },
      testIds: { values: [], withheld: 2 },
      signalGroups: { dashboardSignals: { matched: 0, total: 3 } },
      selectorGroups: {
        startNewQuoteButtons: {
          matched: 1,
          total: 4,
          selectors: [{ count: 0, visible: false }, { count: 0, visible: false }, { count: 0, visible: false }, { count: 1, visible: false }],
        },
        dashboardUploadButtons: { matched: 0, total: 1, selectors: [{ count: 0, visible: false }] },
      },
    });
    expect(JSON.stringify(seen[0])).not.toMatch(/jordan|okafor|example\.com|q24|252/i);
    expect(withCallback.events.setupOrder.filter((step) => step === "collect-page-structure")).toHaveLength(1);
  });

  it.each([
    ["Welcome back. Recent quotes", "https://www.xometry.com/quoting/home/"],
    ["Sign in to continue", "https://www.xometry.com/login/"],
  ])("takes no fingerprint for a classified page (%s)", async (bodyText, url) => {
    const callback = vi.fn();
    const { context, events } = fakeProbeContext({ ...privatePage, bodyText, url });
    await runBoundedXometryAuthProbe(context, { onDashboardNotConfirmed: callback });
    expect(callback).not.toHaveBeenCalled();
    expect(events.setupOrder).not.toContain("collect-page-structure");
  });

  it("reports the classified URL even when the page redirects during the capture", async () => {
    const seen: Array<PageFingerprint | null> = [];
    const plain = await runBoundedXometryAuthProbe(fakeProbeContext(privatePage).context);
    const { context } = fakeProbeContext({ ...privatePage, urlAfterStructureWalk: "https://www.xometry.com/login/" });
    const evidence = await runBoundedXometryAuthProbe(context, { onDashboardNotConfirmed: (fingerprint) => seen.push(fingerprint) });
    expect(evidence).toEqual(plain);
    expect(evidence.url).toBe("https://www.xometry.com/quoting/home/");
    expect(seen[0]?.routeClass).toBe("quote_home");
  });

  it("reports an unavailable capture without changing the classification", async () => {
    const seen: Array<PageFingerprint | null> = [];
    const { context } = fakeProbeContext({ ...privatePage, domStructureError: new Error("private DOM detail") });
    await expect(
      runBoundedXometryAuthProbe(context, { onDashboardNotConfirmed: (fingerprint) => seen.push(fingerprint) }),
    ).resolves.toMatchObject({ reason: "authenticated_dashboard_not_confirmed" });
    expect(seen).toEqual([null]);
  });

  it("gives up on a hung capture after its own bound", async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<PageFingerprint | null> = [];
      const { context } = fakeProbeContext({ ...privatePage, domStructureHangs: true });
      const probe = runBoundedXometryAuthProbe(context, { onDashboardNotConfirmed: (fingerprint) => seen.push(fingerprint) });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(probe).resolves.toMatchObject({ reason: "authenticated_dashboard_not_confirmed" });
      expect(seen).toEqual([null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the classification when the drift callback throws", async () => {
    const { context } = fakeProbeContext(privatePage);
    await expect(
      runBoundedXometryAuthProbe(context, {
        onDashboardNotConfirmed: () => {
          throw new Error("reporting failed");
        },
      }),
    ).resolves.toMatchObject({ reason: "authenticated_dashboard_not_confirmed" });
  });

  it("classifies the final URL as a path class only", () => {
    expect(xometryRouteClass("https://www.xometry.com/quoting/home/?ref=abc")).toBe("quote_home");
    expect(xometryRouteClass("https://www.xometry.com/login/?next=/quoting")).toBe("login");
    expect(xometryRouteClass("https://www.xometry.com/quoting/quote/Q24-1234-5678/")).toBe("quote_page");
    expect(xometryRouteClass("https://www.xometry.com/quoting/new")).toBe("quote_new");
    expect(xometryRouteClass("https://get.xometry.com/welcome")).toBe("provider_other");
    expect(xometryRouteClass("https://evil.example/xometry.com")).toBe("external");
    expect(xometryRouteClass("not a url")).toBe("invalid");
  });
});

describe("bounded restore failure reasons", () => {
  it.each([
    [new XometryProfileSnapshotError("private archive name", "snapshot_corrupt"), "snapshot_corrupt"],
    [new XometryProfileSnapshotError("private token", "credential_unavailable"), "credential_unavailable"],
    [Object.assign(new Error("private path"), { code: "EACCES" }), "filesystem_eacces"],
    [new VendorAutomationError("private lock path", "profile_in_use"), "profile_in_use"],
    [new XometryProfileSnapshotError("private", "private_reason"), "unknown"],
    [Object.assign(new Error("private"), { code: "constructor" }), "unknown"],
    [new Error("private URL cookie token"), "unknown"],
    [{ reason: "snapshot_corrupt", message: "private" }, "unknown"],
  ])("emits only an allowlisted reason", (error, reason) => {
    const evidence = buildXometryAuthProbeFailureEvidence("snapshot_restore", error, "download");
    expect(evidence).toEqual({
      authenticated: false, reason: "probe_failed", failureStage: "snapshot_restore",
      snapshotRestore: { phase: "download", reason }, fileSelectionPerformed: false,
      userInputInteractionPerformed: false, snapshotPersisted: false,
    });
    expect(JSON.stringify(evidence)).not.toContain("private");
    expect(buildXometryAuthProbeFailureEvidence("browser_launch", error, "download"))
      .not.toHaveProperty("snapshotRestore");
  });

  it("contains throwing error accessors and rejects untrusted phase values", () => {
    const error = new XometryProfileSnapshotError("private", "snapshot_corrupt");
    Object.defineProperty(error, "reason", { get() { throw new Error("private getter"); } });
    expect(buildXometryAuthProbeFailureEvidence("snapshot_restore", error, "metadata").snapshotRestore)
      .toEqual({ phase: "metadata", reason: "unknown" });
    let reads = 0;
    const changing = new XometryProfileSnapshotError("private", "snapshot_corrupt");
    Object.defineProperty(changing, "reason", { get() { return reads++ === 0 ? "snapshot_corrupt" : "private"; } });
    expect(buildXometryAuthProbeFailureEvidence("snapshot_restore", changing, "metadata").snapshotRestore)
      .toEqual({ phase: "metadata", reason: "snapshot_corrupt" });
    expect(buildXometryAuthProbeFailureEvidence("snapshot_restore", error, "private" as never))
      .not.toHaveProperty("snapshotRestore");
  });
});
