import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

// This config is never imported by the product config. All identities and data are synthetic.
const emptyQuery = "{data:[],isLoading:false}";
const stubs: Record<string, string> = {
  "@/hooks/use-app-session": `export const useAppSession=()=>({user:{id:'synthetic-admin',email:'admin@example.invalid'},session:{access_token:'synthetic-admin-token',user:{id:'synthetic-admin'}},isPlatformAdmin:new URLSearchParams(location.search).get('role')!=='client',isAuthInitializing:false,activeMembership:{role:'internal_admin',organizationId:'synthetic-org'},signOut:async()=>{}});`,
  "@/features/quotes/use-client-workspace-data": `export const useClientWorkspaceData=()=>({accessibleJobsQuery:${emptyQuery},archivedProjectsQuery:${emptyQuery},archivedJobsQuery:${emptyQuery}});`,
  "@/features/notifications/use-workspace-notifications": `export const WORKSPACE_NOTIFICATION_TYPE_DEFINITIONS={}; export const useWorkspaceNotifications=()=>({allItems:[],items:[],unseenCount:0,typeDefinitions:{},typePreferences:{},supportedTypes:[],browserPermission:'unsupported',markAllSeen:()=>{},setItemSeen:()=>{},setChannelEnabled:()=>{}});`,
  "@/features/quotes/api/workspace-access": "export * from '/src/features/quotes/api/workspace-access.ts'; export const fetchAdminOrganizations=async()=>[]; export const fetchAdminAllUsers=async()=>[]; export const fetchAdminAllJobs=async()=>[]; export const fetchAdminAllProjects=async()=>[];",
  "@/features/quotes/api/commercial-admin-access-api": "export const fetchCommercialAdminAccess=async()=>({hasCapability:false,hasAal2:false});",
  "@/components/admin/ManualQuoteRequestInbox": "import React from 'react'; export const ManualQuoteRequestInbox=()=>React.createElement('h2',null,'Synthetic manual inbox');",
  "@/components/admin/FoundingBetaEnrollmentCard": "import React from 'react'; export const FoundingBetaEnrollmentCard=()=>React.createElement('h2',null,'Synthetic enrollment');",
  "@/components/admin/SpendCapCard": "import React from 'react'; export const SpendCapCard=()=>React.createElement('h2',null,'Synthetic spend');",
  "@/integrations/supabase/client": "export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-admin-token',user:{id:'synthetic-admin'}}},error:null})}};",
};
export default defineConfig({
  root: path.resolve(import.meta.dirname, ".."),
  plugins: [{
    name: "admin-operations-synthetic-only", enforce: "pre",
    resolveId(id) {
      const key = id.startsWith(path.resolve(import.meta.dirname, "../src") + "/")
        ? "@/" + id.slice(path.resolve(import.meta.dirname, "../src").length + 1) : id;
      if (key in stubs) return `\0admin-fixture:${key}`;
    },
    load(id) { if (id.startsWith("\0admin-fixture:")) return stubs[id.slice("\0admin-fixture:".length)]; },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== "/internal/admin") return next();
        res.setHeader("Content-Type", "text/html");
        res.end(await server.transformIndexHtml(req.url!, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/e2e/admin-operations.fixture.tsx"></script></body></html>'));
      });
    },
  }, react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../src") } },
  define: { __APP_VERSION__: JSON.stringify("synthetic-test") },
  server: { host: "127.0.0.1", port: 4174, strictPort: true },
});
