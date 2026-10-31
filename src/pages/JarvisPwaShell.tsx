import { useEffect } from "react";
import { JarvisThread } from "@/features/jarvis/thread/JarvisThread";
import type { ThreadClient } from "@/features/jarvis/thread/client";
import type { EventSource } from "@/features/jarvis/thread/event-source";
import "@/features/jarvis/thread/thread.css";

const idleSource: EventSource = {
  retry() { },
  listen(_events, connection) {
    connection(false);
    return () => { };
  },
};
const idleClient: ThreadClient = {
  resolve: () => Promise.resolve({ status: 409 }),
  control: () => Promise.resolve({ status: 409 }),
};

function installPwaChrome(): () => void {
  const nodes: HTMLElement[] = [];
  const add = (node: HTMLElement) => {
    document.head.append(node);
    nodes.push(node);
  };
  const manifest = document.createElement("link");
  manifest.rel = "manifest";
  manifest.href = "/jarvis/manifest.webmanifest";
  add(manifest);
  const theme = document.createElement("meta");
  theme.name = "theme-color";
  theme.content = "#0E0E10";
  add(theme);
  const capable = document.createElement("meta");
  capable.name = "apple-mobile-web-app-capable";
  capable.content = "yes";
  add(capable);
  const title = document.createElement("meta");
  title.name = "apple-mobile-web-app-title";
  title.content = "Jarvis";
  add(title);
  const icon = document.createElement("link");
  icon.rel = "apple-touch-icon";
  icon.href = "/jarvis/icon-180.png";
  add(icon);
  const viewport = document.querySelector('meta[name="viewport"]');
  const previousViewport = viewport?.getAttribute("content") ?? null;
  viewport?.setAttribute("content", "width=device-width, initial-scale=1.0, viewport-fit=cover");
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/jarvis-sw.js").catch(() => undefined);
  }
  return () => {
    for (const node of nodes) node.remove();
    if (viewport && previousViewport !== null) viewport.setAttribute("content", previousViewport);
  };
}

export default function JarvisPwaShell() {
  useEffect(() => installPwaChrome(), []);
  return (
    <div className="jarvis-page" data-jarvis-pwa-shell>
      <JarvisThread
        source={idleSource}
        client={idleClient}
        runId="jarvis-shell"
        workingName="none"
        note={<p className="jt-muted">Live jobs are not connected yet.</p>}
      />
    </div>
  );
}
