function resolveConfiguredAppUrl(): URL | null {
  const configuredUrl = import.meta.env.VITE_APP_URL?.trim();

  if (!configuredUrl) {
    return null;
  }

  try {
    const url = new URL(configuredUrl);
    url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return url;
  } catch {
    return null;
  }
}

function resolveAppUrl(): URL {
  const configuredUrl = resolveConfiguredAppUrl();

  if (configuredUrl) {
    return configuredUrl;
  }

  if (typeof window !== "undefined") {
    return new URL("/", window.location.origin);
  }

  throw new Error("Unable to resolve auth redirect URL. Set VITE_APP_URL.");
}

export function buildAuthRedirectUrl(path = "/"): string {
  const normalizedPath = path === "/" ? "" : path.replace(/^\/+/, "");
  return new URL(normalizedPath, resolveAppUrl()).toString();
}
