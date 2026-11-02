import { AnnotationToolbar } from "@/components/debug/AnnotationToolbar";
import { lazy, Suspense } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppErrorBoundary } from "@/components/debug/AppErrorBoundary";
import { DiagnosticsBootstrap } from "@/components/debug/DiagnosticsBootstrap";
import { ExtractionLauncher } from "@/components/debug/ExtractionLauncher";
import { ExportControlDeclarationDialogHost } from "@/components/quotes/ExportControlDeclarationDialog";
import { captureDiagnosticError } from "@/lib/diagnostics";
import { shouldCaptureMutationDiagnostic } from "@/lib/react-query-diagnostics";
import { canOpenEngineeringWorkbench } from "@/lib/engineering-workbench-access";
import "./App.css";

const Index = lazy(() => import("./pages/Index"));
const SignIn = lazy(() => import("./pages/SignIn"));
const NotFound = lazy(() => import("./pages/NotFound"));
const JobCreate = lazy(() => import("./pages/JobCreate"));
const InternalAdmin = lazy(() => import("./pages/InternalAdmin"));
const InternalJobDetail = lazy(() => import("./pages/InternalJobDetail"));
const CommercialAccounts = lazy(() => import("./pages/CommercialAccounts"));
const CommercialAccountDetail = lazy(() => import("./pages/CommercialAccountDetail"));
const ClientPackage = lazy(() => import("./pages/ClientPackage"));
const AuthCallback = lazy(() => import("./pages/AuthCallback"));
const DevLogin = lazy(() => import("./pages/DevLogin"));
const ClientProject = lazy(() => import("./pages/ClientProject"));
const ClientPart = lazy(() => import("./pages/ClientPart"));
const ClientParts = lazy(() => import("./pages/ClientParts"));
const ClientQuotes = lazy(() => import("./pages/ClientQuotes"));
const ClientQuoteDetail = lazy(() => import("./pages/ClientQuoteDetail"));
const ClientSearch = lazy(() => import("./pages/ClientSearch"));
const ClientPartReview = lazy(() => import("./pages/ClientPartReview"));
const ClientProjectReview = lazy(() => import("./pages/ClientProjectReview"));
const SharedInvite = lazy(() => import("./pages/SharedInvite"));
const StateGallery = lazy(() => import("./pages/StateGallery"));
const LegalPolicies = lazy(() => import("./pages/LegalPolicies"));
const ConceptsGallery = lazy(() => import("@/concepts/ConceptsGallery").then((m) => ({ default: m.ConceptsGallery })));

// JARVIS_PWA_ENABLED must be exactly "1" at build time. Otherwise the PWA route is absent.
const jarvisPwaEnabled = import.meta.env.JARVIS_PWA_ENABLED === "1";
// Rollback path: with the flag off, retire a Jarvis worker a browser installed while the flag was on.
if (!jarvisPwaEnabled && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistration("/jarvis/")
    .then((registration) => (registration?.scope.endsWith("/jarvis/") ? registration.unregister() : false))
    .catch(() => undefined);
}
const JarvisPwaGate = jarvisPwaEnabled ? lazy(() => import("./pages/JarvisPwaGate")) : null;
const JarvisSample = import.meta.env.DEV && !jarvisPwaEnabled ? lazy(() => import("./pages/Jarvis")) : null;
const JarvisThreadPreview = import.meta.env.DEV ? lazy(() => import("./pages/JarvisThreadPreview")) : null;
const JarvisArPreview = import.meta.env.DEV ? lazy(() => import("./pages/JarvisArPreview")) : null;
// The dynamic import is eliminated from production builds, including its native handoff tooling.
const EngineeringWorkbench = import.meta.env.DEV && import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH === "1"
  ? lazy(() => import("./pages/EngineeringWorkbench"))
  : null;
const EngineeringInbox = import.meta.env.DEV && import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH === "1"
  ? lazy(() => import("./pages/EngineeringInbox"))
  : null;
// Hosted admin entry: compiled out unless the public build flag is exactly "1"; the server allowlist still decides access.
const EngineeringAdminRoute = import.meta.env.VITE_ENABLE_ENGINEERING_ADMIN_ROUTE === "1"
  ? lazy(() => import("./pages/EngineeringAdminRoute"))
  : null;

function formatTargetName(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      captureDiagnosticError(error, {
        category: "react-query",
        source: "react-query.query",
        handled: true,
        message: `Query failed: ${formatTargetName(query.queryKey)}`,
        details: {
          queryHash: query.queryHash,
          queryKey: query.queryKey,
          meta: query.meta ?? null,
        },
      });
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, variables, _context, mutation) => {
      if (
        !shouldCaptureMutationDiagnostic({
          error,
          meta:
            mutation.options.meta && typeof mutation.options.meta === "object" && !Array.isArray(mutation.options.meta)
              ? mutation.options.meta
              : undefined,
        })
      ) {
        return;
      }

      captureDiagnosticError(error, {
        category: "react-mutation",
        source: "react-query.mutation",
        handled: true,
        message: `Mutation failed: ${formatTargetName(mutation.options.mutationKey ?? mutation.options.meta ?? "anonymous")}`,
        details: {
          mutationKey: mutation.options.mutationKey ?? null,
          meta: mutation.options.meta ?? null,
          variables,
        },
      });
    },
  }),
});

function shouldRenderAgentation() {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return false;
  }

  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get("embed") !== "1" && searchParams.get("app") !== "ios";
}

const App = () => {
  if (EngineeringWorkbench && typeof window !== "undefined"
    && window.location.pathname === "/dev/engineering"
    && canOpenEngineeringWorkbench(import.meta.env.DEV, import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH, window.location.hostname)) {
    return (
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
        <TooltipProvider>
          <Suspense fallback={<output className="block p-8">Opening engineering workbench…</output>}>
            <EngineeringWorkbench />
          </Suspense>
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  return (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <ExportControlDeclarationDialogHost />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <DiagnosticsBootstrap />
          <ExtractionLauncher hideFloatingButton />
          {shouldRenderAgentation() && <AnnotationToolbar />}
          <AppErrorBoundary>
            <Suspense fallback={<output className="block p-8">Loading page…</output>}>
              <Routes>
                {JarvisThreadPreview && <Route path="/dev/jarvis-thread" element={<Suspense fallback={<p>Opening thread</p>}><JarvisThreadPreview /></Suspense>} />}
                {EngineeringInbox && canOpenEngineeringWorkbench(import.meta.env.DEV, import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH, window.location.hostname)
                  ? <Route path="/engineering" element={<Suspense fallback={<p>Opening conversation…</p>}><EngineeringInbox /></Suspense>} />
                  : EngineeringAdminRoute && <Route path="/engineering" element={<Suspense fallback={null}><EngineeringAdminRoute /></Suspense>} />}
                {JarvisArPreview && <Route path="/dev/jarvis-ar" element={<Suspense fallback={<p>Opening AR preview</p>}><JarvisArPreview /></Suspense>} />}
                {JarvisPwaGate && <Route path="/jarvis" element={<Suspense fallback={null}><JarvisPwaGate /></Suspense>} />}
                {JarvisPwaGate && <Route path="/jarvis/" element={<Suspense fallback={null}><JarvisPwaGate /></Suspense>} />}
                {JarvisSample && <Route path="/jarvis" element={<Suspense fallback={<p>Opening Jarvis</p>}><JarvisSample /></Suspense>} />}
                <Route path="/" element={<Index />} />
                <Route path="/parts" element={<ClientParts />} />
                <Route path="/projects/:projectId" element={<ClientProject />} />
                <Route path="/projects/:projectId/review" element={<ClientProjectReview />} />
                <Route path="/parts/:jobId" element={<ClientPart />} />
                <Route path="/parts/:jobId/review" element={<ClientPartReview />} />
                <Route path="/quotes" element={<ClientQuotes />} />
                <Route path="/quotes/:quoteCode" element={<ClientQuoteDetail />} />
                <Route path="/search" element={<ClientSearch />} />
                <Route path="/shared/:inviteToken" element={<SharedInvite />} />
                <Route path="/jobs/new" element={<JobCreate />} />
                <Route path="/internal/admin" element={<InternalAdmin />} />
                <Route path="/internal/commercial" element={<CommercialAccounts />} />
                <Route
                  path="/internal/commercial/:organizationId"
                  element={<CommercialAccountDetail />}
                />
                <Route path="/internal/jobs/:jobId" element={<InternalJobDetail />} />
                <Route path="/client/packages/:packageId" element={<ClientPackage />} />
                <Route path="/signin" element={<SignIn />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route path="/legal/terms" element={<LegalPolicies policy="terms" />} />
                <Route path="/legal/beta-terms" element={<LegalPolicies policy="terms" />} />
                <Route path="/legal/privacy" element={<LegalPolicies policy="privacy" />} />
                <Route path="/dev-login" element={<DevLogin />} />
                <Route path="/debug/state-gallery" element={<StateGallery />} />
                <Route path="/debug/concepts" element={<ConceptsGallery />} />
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </AppErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
  );
};

export default App;
