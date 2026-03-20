import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchClientActivityEventsByJobIds,
} from "@/features/quotes/api/workspace-access";
import type { AppMembership, ClientActivityEvent } from "@/features/quotes/types";
import {
  stableJobIds,
  WORKSPACE_GC_TIME_MS,
  WORKSPACE_SHARED_STALE_TIME_MS,
  workspaceQueryKeys,
} from "@/features/quotes/workspace-navigation";

export type WorkspaceNotificationType =
  | "client.quote_package_ready"
  | "internal.extraction_attention_required"
  | "internal.quote_responses_ready"
  | "internal.quote_follow_up_required"
  | "internal.quote_collection_failed"
  | "internal.client_selection_received";

export type WorkspaceNotificationChannel = "inApp" | "browser";
export type BrowserNotificationPermissionState = NotificationPermission | "unsupported";

export type WorkspaceNotificationItem = {
  id: string;
  detail: string;
  jobId: string;
  notificationType: WorkspaceNotificationType;
  occurredAt: string;
  packageId: string | null;
  sourceEventId: string;
  title: string;
  tone: "default" | "active" | "attention";
};

export type WorkspaceNotificationCenterItem = WorkspaceNotificationItem & {
  isSeen: boolean;
};

export type WorkspaceNotificationChannelPreferences = {
  browser: boolean;
  inApp: boolean;
};

export type WorkspaceNotificationDefinition = {
  description: string;
  label: string;
};

export type WorkspaceNotificationsController = {
  allItems: WorkspaceNotificationCenterItem[];
  browserPermission: BrowserNotificationPermissionState;
  isLoading: boolean;
  isRequestingPermission: boolean;
  items: WorkspaceNotificationCenterItem[];
  markAllSeen: () => void;
  requestBrowserPermission: () => Promise<void>;
  setChannelEnabled: (
    notificationType: WorkspaceNotificationType,
    channel: WorkspaceNotificationChannel,
    enabled: boolean,
  ) => void;
  setItemSeen: (notificationId: string, seen: boolean) => void;
  supportedTypes: WorkspaceNotificationType[];
  typeDefinitions: Record<WorkspaceNotificationType, WorkspaceNotificationDefinition>;
  typePreferences: Record<WorkspaceNotificationType, WorkspaceNotificationChannelPreferences>;
  unseenCount: number;
};

type PersistedNotificationPreferences = {
  typePreferences: Partial<Record<WorkspaceNotificationType, Partial<WorkspaceNotificationChannelPreferences>>>;
  version: 1;
};

type PersistedNotificationState = {
  browserDeliveredAtById: Record<string, string>;
  browserPrimedAt: string | null;
  seenAtById: Record<string, string>;
  version: 1;
};

const EMPTY_NOTIFICATION_MAP: Record<string, never> = {};
const NOTIFICATION_PREFERENCES_VERSION = 1;
const NOTIFICATION_STATE_VERSION = 1;

export const WORKSPACE_NOTIFICATION_TYPE_DEFINITIONS: Record<
  WorkspaceNotificationType,
  WorkspaceNotificationDefinition
> = {
  "client.quote_package_ready": {
    label: "Quote package ready",
    description: "Notify me when curated quote options are published to a project or part I can access.",
  },
  "internal.extraction_attention_required": {
    label: "Extraction needs attention",
    description: "Notify me when file extraction stalls and internal review needs to intervene.",
  },
  "internal.quote_responses_ready": {
    label: "Quote responses ready",
    description: "Notify me when vendor responses are ready for internal review.",
  },
  "internal.quote_follow_up_required": {
    label: "Vendor follow-up required",
    description: "Notify me when quote collection still needs manual vendor follow-up.",
  },
  "internal.quote_collection_failed": {
    label: "Quote collection failed",
    description: "Notify me when quote collection ends without a publishable result.",
  },
  "internal.client_selection_received": {
    label: "Client selection received",
    description: "Notify me when a client records a quote-package selection that changes downstream work.",
  },
};

const DEFAULT_CHANNEL_PREFERENCES: WorkspaceNotificationChannelPreferences = {
  inApp: true,
  browser: false,
};

const EMPTY_CONTROLLER: WorkspaceNotificationsController = {
  allItems: [],
  browserPermission: "unsupported",
  isLoading: false,
  isRequestingPermission: false,
  items: [],
  markAllSeen: () => undefined,
  requestBrowserPermission: async () => undefined,
  setChannelEnabled: () => undefined,
  setItemSeen: () => undefined,
  supportedTypes: [],
  typeDefinitions: WORKSPACE_NOTIFICATION_TYPE_DEFINITIONS,
  typePreferences: {
    "client.quote_package_ready": DEFAULT_CHANNEL_PREFERENCES,
    "internal.extraction_attention_required": DEFAULT_CHANNEL_PREFERENCES,
    "internal.quote_responses_ready": DEFAULT_CHANNEL_PREFERENCES,
    "internal.quote_follow_up_required": DEFAULT_CHANNEL_PREFERENCES,
    "internal.quote_collection_failed": DEFAULT_CHANNEL_PREFERENCES,
    "internal.client_selection_received": DEFAULT_CHANNEL_PREFERENCES,
  },
  unseenCount: 0,
};

function getPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "unsupported";
  }

  return window.Notification.permission;
}

function getPreferencesStorageKey(userId: string | null | undefined) {
  return userId ? `workspace-notification-preferences-v${NOTIFICATION_PREFERENCES_VERSION}:${userId}` : null;
}

function getStateStorageKey(userId: string | null | undefined) {
  return userId ? `workspace-notification-state-v${NOTIFICATION_STATE_VERSION}:${userId}` : null;
}

function readStoredJson(storageKey: string | null) {
  if (!storageKey || typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(storageKey);

    if (!rawValue) {
      return null;
    }

    return JSON.parse(rawValue) as unknown;
  } catch {
    return null;
  }
}

function persistJson(storageKey: string | null, value: unknown) {
  if (!storageKey || typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Ignore private-mode or unsupported storage failures.
  }
}

function resolveTypePreferences(
  rawValue: PersistedNotificationPreferences | null,
): Record<WorkspaceNotificationType, WorkspaceNotificationChannelPreferences> {
  const storedPreferences = rawValue?.version === NOTIFICATION_PREFERENCES_VERSION ? rawValue.typePreferences : {};

  return {
    "client.quote_package_ready": {
      inApp: storedPreferences?.["client.quote_package_ready"]?.inApp ?? true,
      browser: storedPreferences?.["client.quote_package_ready"]?.browser ?? false,
    },
    "internal.extraction_attention_required": {
      inApp: storedPreferences?.["internal.extraction_attention_required"]?.inApp ?? true,
      browser: storedPreferences?.["internal.extraction_attention_required"]?.browser ?? false,
    },
    "internal.quote_responses_ready": {
      inApp: storedPreferences?.["internal.quote_responses_ready"]?.inApp ?? true,
      browser: storedPreferences?.["internal.quote_responses_ready"]?.browser ?? false,
    },
    "internal.quote_follow_up_required": {
      inApp: storedPreferences?.["internal.quote_follow_up_required"]?.inApp ?? true,
      browser: storedPreferences?.["internal.quote_follow_up_required"]?.browser ?? false,
    },
    "internal.quote_collection_failed": {
      inApp: storedPreferences?.["internal.quote_collection_failed"]?.inApp ?? true,
      browser: storedPreferences?.["internal.quote_collection_failed"]?.browser ?? false,
    },
    "internal.client_selection_received": {
      inApp: storedPreferences?.["internal.client_selection_received"]?.inApp ?? true,
      browser: storedPreferences?.["internal.client_selection_received"]?.browser ?? false,
    },
  };
}

function resolvePersistedState(rawValue: PersistedNotificationState | null): PersistedNotificationState {
  if (rawValue?.version === NOTIFICATION_STATE_VERSION) {
    return {
      version: NOTIFICATION_STATE_VERSION,
      seenAtById: rawValue.seenAtById ?? EMPTY_NOTIFICATION_MAP,
      browserDeliveredAtById: rawValue.browserDeliveredAtById ?? EMPTY_NOTIFICATION_MAP,
      browserPrimedAt: rawValue.browserPrimedAt ?? null,
    };
  }

  return {
    version: NOTIFICATION_STATE_VERSION,
    seenAtById: EMPTY_NOTIFICATION_MAP,
    browserDeliveredAtById: EMPTY_NOTIFICATION_MAP,
    browserPrimedAt: null,
  };
}

function getSupportedWorkspaceNotificationTypes(role: AppMembership["role"] | null | undefined) {
  switch (role) {
    case "internal_admin":
    case "internal_estimator":
      return [
        "internal.extraction_attention_required",
        "internal.quote_responses_ready",
        "internal.quote_follow_up_required",
        "internal.quote_collection_failed",
        "internal.client_selection_received",
      ] as WorkspaceNotificationType[];
    case "client":
    default:
      return ["client.quote_package_ready"] as WorkspaceNotificationType[];
  }
}

function getEventTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function buildNotificationDetail(
  event: ClientActivityEvent,
  notificationType: WorkspaceNotificationType,
): Pick<WorkspaceNotificationItem, "detail" | "title" | "tone"> {
  switch (notificationType) {
    case "internal.extraction_attention_required":
      return {
        title: "Extraction needs attention",
        detail: "The system could not finish reading the attached part package yet.",
        tone: "attention",
      };
    case "internal.quote_responses_ready":
      return {
        title: "Quote responses ready",
        detail: "Vendor responses are ready for internal review.",
        tone: "active",
      };
    case "internal.quote_follow_up_required":
      return {
        title: "Vendor follow-up required",
        detail: "Some vendor lanes still need manual follow-up before publication.",
        tone: "attention",
      };
    case "internal.quote_collection_failed":
      return {
        title: "Quote collection failed",
        detail: "Quote collection ended without a publishable result.",
        tone: "attention",
      };
    case "internal.client_selection_received":
      return {
        title: "Client selection received",
        detail: "A client selected a quote option and the downstream workflow changed.",
        tone: "active",
      };
    case "client.quote_package_ready":
    default:
      return {
        title: "Quote package ready",
        detail:
          event.packageId !== null
            ? "Curated quote options are available for review in this workspace."
            : "A published quote package is now available for review.",
        tone: "active",
      };
  }
}

function getNotificationTypeForEvent(event: ClientActivityEvent): WorkspaceNotificationType | null {
  switch (event.eventType) {
    case "worker.extraction_failed":
      return "internal.extraction_attention_required";
    case "worker.quote_run_completed":
      return "internal.quote_responses_ready";
    case "worker.quote_run_attention_needed":
      return "internal.quote_follow_up_required";
    case "worker.quote_run_failed":
      return "internal.quote_collection_failed";
    case "job.quote_package_published":
      return "client.quote_package_ready";
    case "client.quote_option_selected":
      return "internal.client_selection_received";
    default:
      return null;
  }
}

function getNotificationDedupeKey(
  event: ClientActivityEvent,
  notificationType: WorkspaceNotificationType,
): string {
  if (event.packageId) {
    return `${notificationType}:${event.packageId}`;
  }

  return `${notificationType}:${event.id}`;
}

export function buildWorkspaceNotificationItems(
  events: ClientActivityEvent[],
  role: AppMembership["role"] | null | undefined,
): WorkspaceNotificationItem[] {
  const supportedTypes = new Set(getSupportedWorkspaceNotificationTypes(role));
  const notificationsById = new Map<string, WorkspaceNotificationItem>();

  [...events]
    .sort((left, right) => getEventTimestamp(right.occurredAt) - getEventTimestamp(left.occurredAt))
    .forEach((event) => {
      const notificationType = getNotificationTypeForEvent(event);

      if (!notificationType || !supportedTypes.has(notificationType)) {
        return;
      }

      const dedupeKey = getNotificationDedupeKey(event, notificationType);

      if (notificationsById.has(dedupeKey)) {
        return;
      }

      const detail = buildNotificationDetail(event, notificationType);

      notificationsById.set(dedupeKey, {
        id: dedupeKey,
        sourceEventId: event.id,
        notificationType,
        occurredAt: event.occurredAt,
        jobId: event.jobId,
        packageId: event.packageId,
        ...detail,
      });
    });

  return [...notificationsById.values()].sort(
    (left, right) => getEventTimestamp(right.occurredAt) - getEventTimestamp(left.occurredAt),
  );
}

function createPreviewBrowserNotification() {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return;
  }

  try {
    new window.Notification("Browser notifications enabled", {
      body: "New quote-workflow updates will now appear here when this browser is opted in.",
      tag: "workspace-notification-preview",
    });
  } catch {
    // Ignore constructor failures in unsupported browser contexts.
  }
}

type UseWorkspaceNotificationsOptions = {
  jobIds: string[];
  role: AppMembership["role"] | null | undefined;
  userId?: string | null;
};

export function useWorkspaceNotifications({
  jobIds,
  role,
  userId,
}: UseWorkspaceNotificationsOptions): WorkspaceNotificationsController {
  const normalizedJobIds = useMemo(() => stableJobIds(jobIds), [jobIds]);
  const supportedTypes = useMemo(() => getSupportedWorkspaceNotificationTypes(role), [role]);
  const [browserPermission, setBrowserPermission] = useState<BrowserNotificationPermissionState>(getPermissionState);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [typePreferences, setTypePreferences] = useState<Record<
    WorkspaceNotificationType,
    WorkspaceNotificationChannelPreferences
  >>(() => resolveTypePreferences(readStoredJson(getPreferencesStorageKey(userId)) as PersistedNotificationPreferences | null));
  const [persistedState, setPersistedState] = useState<PersistedNotificationState>(() =>
    resolvePersistedState(readStoredJson(getStateStorageKey(userId)) as PersistedNotificationState | null),
  );

  const activityQuery = useQuery({
    queryKey: [...workspaceQueryKeys.clientActivity(normalizedJobIds), "notification-center"],
    queryFn: () => fetchClientActivityEventsByJobIds(normalizedJobIds, 12),
    enabled: Boolean(userId) && normalizedJobIds.length > 0,
    staleTime: WORKSPACE_SHARED_STALE_TIME_MS,
    gcTime: WORKSPACE_GC_TIME_MS,
  });

  useEffect(() => {
    setTypePreferences(
      resolveTypePreferences(readStoredJson(getPreferencesStorageKey(userId)) as PersistedNotificationPreferences | null),
    );
    setPersistedState(resolvePersistedState(readStoredJson(getStateStorageKey(userId)) as PersistedNotificationState | null));
    setBrowserPermission(getPermissionState());
  }, [userId]);

  useEffect(() => {
    const refreshPermission = () => {
      setBrowserPermission(getPermissionState());
    };

    if (typeof window === "undefined") {
      return;
    }

    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshPermission);

    return () => {
      window.removeEventListener("focus", refreshPermission);
      document.removeEventListener("visibilitychange", refreshPermission);
    };
  }, []);

  useEffect(() => {
    persistJson(getPreferencesStorageKey(userId), {
      version: NOTIFICATION_PREFERENCES_VERSION,
      typePreferences,
    } satisfies PersistedNotificationPreferences);
  }, [typePreferences, userId]);

  useEffect(() => {
    persistJson(getStateStorageKey(userId), persistedState);
  }, [persistedState, userId]);

  const allItems = useMemo(
    () =>
      buildWorkspaceNotificationItems(activityQuery.data ?? [], role).map((item) => ({
        ...item,
        isSeen: Boolean(persistedState.seenAtById[item.id]),
      })),
    [activityQuery.data, persistedState.seenAtById, role],
  );

  const items = useMemo(
    () => allItems.filter((item) => supportedTypes.includes(item.notificationType) && typePreferences[item.notificationType].inApp),
    [allItems, supportedTypes, typePreferences],
  );

  const unseenCount = useMemo(
    () => items.filter((item) => !item.isSeen).length,
    [items],
  );

  useEffect(() => {
    if (browserPermission !== "granted" || !persistedState.browserPrimedAt) {
      return;
    }

    const primedAtTimestamp = getEventTimestamp(persistedState.browserPrimedAt);
    const deliveredNotifications: Array<{ id: string; deliveredAt: string }> = [];

    allItems.forEach((item) => {
      if (!supportedTypes.includes(item.notificationType)) {
        return;
      }

      if (!typePreferences[item.notificationType].browser) {
        return;
      }

      if (persistedState.browserDeliveredAtById[item.id]) {
        return;
      }

      if (getEventTimestamp(item.occurredAt) <= primedAtTimestamp) {
        return;
      }

      try {
        new window.Notification(item.title, {
          body: item.detail,
          tag: item.id,
        });
        deliveredNotifications.push({
          id: item.id,
          deliveredAt: new Date().toISOString(),
        });
      } catch {
        // Ignore browser notification constructor failures.
      }
    });

    if (deliveredNotifications.length === 0) {
      return;
    }

    setPersistedState((current) => ({
      ...current,
      browserDeliveredAtById: deliveredNotifications.reduce<Record<string, string>>(
        (nextMap, notification) => ({
          ...nextMap,
          [notification.id]: notification.deliveredAt,
        }),
        current.browserDeliveredAtById,
      ),
    }));
  }, [
    allItems,
    browserPermission,
    persistedState.browserDeliveredAtById,
    persistedState.browserPrimedAt,
    supportedTypes,
    typePreferences,
  ]);

  const markAllSeen = () => {
    if (items.length === 0) {
      return;
    }

    const seenAt = new Date().toISOString();

    setPersistedState((current) => ({
      ...current,
      seenAtById: items.reduce<Record<string, string>>(
        (nextMap, item) => ({
          ...nextMap,
          [item.id]: current.seenAtById[item.id] ?? seenAt,
        }),
        current.seenAtById,
      ),
    }));
  };

  const setItemSeen = (notificationId: string, seen: boolean) => {
    setPersistedState((current) => {
      if (seen) {
        if (current.seenAtById[notificationId]) {
          return current;
        }

        return {
          ...current,
          seenAtById: {
            ...current.seenAtById,
            [notificationId]: new Date().toISOString(),
          },
        };
      }

      if (!current.seenAtById[notificationId]) {
        return current;
      }

      const nextSeenAtById = { ...current.seenAtById };
      delete nextSeenAtById[notificationId];

      return {
        ...current,
        seenAtById: nextSeenAtById,
      };
    });
  };

  const setChannelEnabled = (
    notificationType: WorkspaceNotificationType,
    channel: WorkspaceNotificationChannel,
    enabled: boolean,
  ) => {
    setTypePreferences((current) => ({
      ...current,
      [notificationType]: {
        ...current[notificationType],
        [channel]: enabled,
      },
    }));

    if (channel === "browser" && enabled && browserPermission === "granted") {
      setPersistedState((current) => ({
        ...current,
        browserPrimedAt: new Date().toISOString(),
      }));
      createPreviewBrowserNotification();
    }
  };

  const requestBrowserPermission = async () => {
    if (typeof window === "undefined" || typeof window.Notification === "undefined") {
      setBrowserPermission("unsupported");
      return;
    }

    if (window.Notification.permission === "granted") {
      setBrowserPermission("granted");
      return;
    }

    setIsRequestingPermission(true);

    try {
      const permission = await window.Notification.requestPermission();
      setBrowserPermission(permission);
    } finally {
      setIsRequestingPermission(false);
    }
  };

  if (!userId) {
    return EMPTY_CONTROLLER;
  }

  return {
    allItems,
    browserPermission,
    isLoading: activityQuery.isLoading,
    isRequestingPermission,
    items,
    markAllSeen,
    requestBrowserPermission,
    setChannelEnabled,
    setItemSeen,
    supportedTypes,
    typeDefinitions: WORKSPACE_NOTIFICATION_TYPE_DEFINITIONS,
    typePreferences,
    unseenCount,
  };
}
