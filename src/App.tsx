import { Suspense, lazy } from "react";
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
import { captureDiagnosticError } from "@/lib/diagnostics";
import "./App.css";

const Index = lazy(() => import("./pages/Index"));
const SignIn = lazy(() => import("./pages/SignIn"));
const NotFound = lazy(() => import("./pages/NotFound"));
const JobCreate = lazy(() => import("./pages/JobCreate"));
const InternalJobDetail = lazy(() => import("./pages/InternalJobDetail"));
const ClientPackage = lazy(() => import("./pages/ClientPackage"));
const AuthCallback = lazy(() => import("./pages/AuthCallback"));
const ClientProject = lazy(() => import("./pages/ClientProject"));
const ClientPart = lazy(() => import("./pages/ClientPart"));
const SharedInvite = lazy(() => import("./pages/SharedInvite"));

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

function AppRoutesFallback() {
  return <div aria-hidden="true" className="min-h-screen" />;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <DiagnosticsBootstrap />
        <AppErrorBoundary>
          <Suspense fallback={<AppRoutesFallback />}>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/projects/:projectId" element={<ClientProject />} />
              <Route path="/parts/:jobId" element={<ClientPart />} />
              <Route path="/shared/:inviteToken" element={<SharedInvite />} />
              <Route path="/jobs/new" element={<JobCreate />} />
              <Route path="/internal/jobs/:jobId" element={<InternalJobDetail />} />
              <Route path="/client/packages/:packageId" element={<ClientPackage />} />
              <Route path="/signin" element={<SignIn />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </AppErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
