import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { Toaster } from "sonner";
import ClientPart from "../../src/pages/ClientPart";
import { ID } from "./data";
import "../../src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <MemoryRouter initialEntries={[`/parts/${ID.job}`]}>
        <Routes><Route path="/parts/:jobId" element={<ClientPart />} /></Routes>
      </MemoryRouter>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
);
