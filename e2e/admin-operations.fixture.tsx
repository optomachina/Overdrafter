/** Synthetic shell around the actual InternalAdmin page; enabled only by the dedicated test config. */
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import InternalAdmin from "../src/pages/InternalAdmin";
import "../src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={["/internal/admin"]}><InternalAdmin /></MemoryRouter>
  </QueryClientProvider>,
);
