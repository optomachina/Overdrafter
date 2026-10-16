/**
 * Capability manifest for OVD-825 journey tests.
 *
 * One entry per user-facing surface. Entry points are the doors a user is
 * expected to walk through; they are claims, not proof. The reachability test
 * (src/journeys/reachability.test.ts) checks every claim against the code: the
 * app router, the Vercel rewrites, the api/ functions and the Supabase edge
 * functions. A surface whose entry points all fail that check fails CI unless
 * it is marked `knownMissing`, and a `knownMissing` surface that becomes
 * reachable fails until the marker is removed.
 */

export type LinearIssue = `OVD-${number}`;

/** A client route rendered by the app router in src/App.tsx. */
export interface RouteEntryPoint {
  readonly kind: "route";
  readonly path: string;
}

/** A navigable link to `to`, shown on the `from` route. */
export interface LinkEntryPoint {
  readonly kind: "link";
  readonly from: string;
  readonly to: string;
}

/** A production HTTP endpoint (Vercel function or Supabase edge function) a channel posts to. */
export interface WebhookEntryPoint {
  readonly kind: "webhook";
  readonly path: string;
}

export type EntryPoint = RouteEntryPoint | LinkEntryPoint | WebhookEntryPoint;

export type ChannelName = "slack" | "telegram" | "imessage";

export interface KnownMissing {
  /** The issue that will give this surface a front door. */
  readonly issue: LinearIssue;
  readonly reason: string;
}

export interface CapabilitySurface {
  readonly id: string;
  readonly name: string;
  readonly linearIssue: LinearIssue;
  readonly entryPoints: readonly EntryPoint[];
  /**
   * Messaging channel this surface is served on. The test also searches the
   * production function directories for a handler named after the channel, so
   * an adapter shipped at an unplanned path still trips the ratchet.
   */
  readonly channel?: ChannelName;
  readonly knownMissing?: KnownMissing;
}

export const capabilityManifest: readonly CapabilitySurface[] = [
  {
    id: "jarvis-web",
    name: "Jarvis phone web app",
    linearIssue: "OVD-803",
    entryPoints: [
      // The only Jarvis-like page today: the engineering conversation behind a
      // build flag and the platform admin allowlist.
      { kind: "route", path: "/engineering" },
      { kind: "route", path: "/jarvis" },
      { kind: "link", from: "/", to: "/jarvis" },
    ],
    knownMissing: {
      issue: "OVD-805",
      reason:
        "Only the flag-gated, admin-only /engineering page exists; there is no public route or link to Jarvis.",
    },
  },
  {
    id: "jarvis-slack",
    name: "Jarvis in Slack",
    linearIssue: "OVD-807",
    channel: "slack",
    entryPoints: [{ kind: "webhook", path: "/api/jarvis/slack" }],
    knownMissing: {
      issue: "OVD-807",
      reason: "Only the Hermes demo skill on the Mac mini (scripts/jarvis-demo) answers Slack; no production webhook.",
    },
  },
  {
    id: "jarvis-telegram",
    name: "Jarvis in Telegram",
    linearIssue: "OVD-808",
    channel: "telegram",
    entryPoints: [{ kind: "webhook", path: "/api/jarvis/telegram" }],
    knownMissing: {
      issue: "OVD-808",
      reason: "Only the Hermes demo skill on the Mac mini (scripts/jarvis-demo) answers Telegram; no production webhook.",
    },
  },
  {
    id: "jarvis-imessage",
    name: "Jarvis in iMessage",
    linearIssue: "OVD-809",
    channel: "imessage",
    entryPoints: [{ kind: "webhook", path: "/api/jarvis/imessage" }],
    knownMissing: {
      issue: "OVD-809",
      reason: "No iMessage bridge exists yet.",
    },
  },
  {
    id: "overdrafter-quote-flow",
    name: "OverDrafter quote flow",
    linearIssue: "OVD-825",
    entryPoints: [
      { kind: "route", path: "/" },
      { kind: "route", path: "/quotes" },
      { kind: "route", path: "/quotes/:quoteCode" },
      { kind: "link", from: "/", to: "/quotes" },
    ],
  },
  {
    id: "client-part-workspace",
    name: "Client part workspace",
    linearIssue: "OVD-825",
    entryPoints: [
      { kind: "route", path: "/parts" },
      { kind: "route", path: "/parts/:jobId" },
    ],
  },
];
