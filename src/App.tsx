import { lazy, Suspense } from "react";
import { ThemeProvider } from "next-themes";
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
import { captureDiagnosticError } from "@/lib/diagnostics";
import { shouldCaptureMutationDiagnostic } from "@/lib/react-query-diagnostics";
import { canOpenEngineeringWorkbench } from "@/lib/engineering-workbench-access";
import "./App.css";

// Route pages load on demand so the first paint only pays for the page being opened.
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
const ClientProject = lazy(() => import("./pages/ClientProject"));
const ClientPart = lazy(() => import("./pages/ClientPart"));
const ClientParts = lazy(() => import("./pages/ClientParts"));
const ClientQuotes = lazy(() => import("./pages/ClientQuotes"));
const ClientQuoteDetail = lazy(() => import("./pages/ClientQuoteDetail"));
const ClientSearch = lazy(() => import("./pages/ClientSearch"));
const ClientPartReview = lazy(() => import("./pages/ClientPartReview"));
const ClientProjectReview = lazy(() => import("./pages/ClientProjectReview"));
const SharedInvite = lazy(() => import("./pages/SharedInvite"));
const LegalPolicies = lazy(() => import("./pages/LegalPolicies"));

// Debug-only surfaces: the dynamic imports are eliminated from production builds.
const DevLogin = import.meta.env.DEV ? lazy(() => import("./pages/DevLogin")) : null;
const StateGallery = import.meta.env.DEV ? lazy(() => import("./pages/StateGallery")) : null;
const ConceptsGallery = import.meta.env.DEV
  ? lazy(() => import("@/concepts/ConceptsGallery").then((module) => ({ default: module.ConceptsGallery })))
  : null;
const AnnotationToolbar = import.meta.env.DEV
  ? lazy(() => import("@/components/debug/AnnotationToolbar").then((module) => ({ default: module.AnnotationToolbar })))
  : null;

// The dynamic import is eliminated from production builds, including its native handoff tooling.
const EngineeringWorkbench = import.meta.env.DEV && import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH === "1"
  ? lazy(() => import("./pages/EngineeringWorkbench"))
  : null;
const EngineeringInbox = import.meta.env.DEV && import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH === "1"
  ? lazy(() => import("./pages/EngineeringInbox"))
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
        <Sonner />
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <DiagnosticsBootstrap />
          <ExtractionLauncher hideFloatingButton />
          {AnnotationToolbar && shouldRenderAgentation() && (
            <Suspense fallback={null}>
              <AnnotationToolbar />
            </Suspense>
          )}
          <AppErrorBoundary>
            <Suspense fallback={<output className="block p-8">Loading…</output>}>
            <Routes>
              {EngineeringInbox && canOpenEngineeringWorkbench(import.meta.env.DEV, import.meta.env.VITE_ENABLE_ENGINEERING_WORKBENCH, window.location.hostname)
                && <Route path="/engineering" element={<Suspense fallback={<p>Opening conversation…</p>}><EngineeringInbox /></Suspense>} />}
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
              {DevLogin && <Route path="/dev-login" element={<DevLogin />} />}
              {StateGallery && <Route path="/debug/state-gallery" element={<StateGallery />} />}
              {ConceptsGallery && <Route path="/debug/concepts" element={<ConceptsGallery />} />}
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
