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
import Index from "./pages/Index";
import SignIn from "./pages/SignIn";
import NotFound from "./pages/NotFound";
import JobCreate from "./pages/JobCreate";
import InternalJobDetail from "./pages/InternalJobDetail";
import ClientPackage from "./pages/ClientPackage";
import AuthCallback from "./pages/AuthCallback";
import ClientProject from "./pages/ClientProject";
import ClientPart from "./pages/ClientPart";
import SharedInvite from "./pages/SharedInvite";
import "./App.css";

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

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <DiagnosticsBootstrap />
        <AppErrorBoundary>
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
        </AppErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
