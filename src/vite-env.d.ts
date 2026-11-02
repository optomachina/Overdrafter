/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_URL?: string;
  readonly VITE_ENABLE_ENGINEERING_ADMIN_ROUTE?: string;
  readonly JARVIS_PWA_ENABLED?: string;
  readonly VITE_ENABLE_FIXTURE_MODE?: string;
  readonly VITE_ENABLE_QUOTE_PROVIDER_NOTES?: string;
  readonly VITE_CONTROLLED_BETA_SINGLE_QUANTITY?: string;
  readonly VITE_WORKER_BASE_URL?: string;
  readonly VITE_WORKER_WAKE_ON_SUBMIT?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_BILLING_SELF_SERVICE_ENABLED?: string;
  readonly VITE_BILLING_TIER_CATALOG_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
