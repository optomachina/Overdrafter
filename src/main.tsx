import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { ThemeProvider } from "next-themes";
import { canOpenEngineeringWorkbench } from "./lib/engineering-workbench-access";
import "./index.css";

// Resolve the local-only route before importing the hosted app and its database
// client. The plate demo has no hosted credentials or database dependency.
const sample = import.meta.env.DEV && window.location.pathname === "/dev/engineering/plate"
  && canOpenEngineeringWorkbench(import.meta.env.DEV, import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH, window.location.hostname);
const Root = sample ? lazy(() => import("./pages/EngineeringPlateDemo")) : lazy(() => import("./App"));
createRoot(document.getElementById("root")!).render(<Suspense fallback={<p>Opening OverDrafter…</p>}>
  {sample ? <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}><Root /></ThemeProvider> : <Root />}
</Suspense>);
