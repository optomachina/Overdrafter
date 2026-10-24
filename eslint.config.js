import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// OVD-874: provider adapters (worker/src/adapters/*) may only be reached through
// the dispatch modules, so admission and kill-switch checks cannot be bypassed.
// Report mode ("warn") for one week; switching to "error" is tracked on the card.
const ADAPTER_IMPORT_PATTERN = {
  regex: "(^|/)adapters(/|$)",
  message:
    "Import provider adapters only through the dispatch module (worker/src/index.ts). See OVD-874.",
};

// Existing importers of worker/src/adapters/*. Each entry is explicit so new
// importers show up as warnings instead of being silently allowed.
const ADAPTER_IMPORT_ALLOWLIST = [
  // The adapters' own files and tests.
  "worker/src/adapters/**",
  // Dispatch modules: the registry is built in index.ts. The routing and
  // preflight modules accept adapters as parameters (type-only today).
  "worker/src/index.ts",
  "worker/src/dispatchRouting.ts",
  "worker/src/providerDispatchPreflight.ts",
  "worker/src/xometryDispatchPreflight.ts",
  // Worker tests and their shared fixtures.
  "worker/src/**/*.test.ts",
  "worker/test-support/**",
  // Pure helpers that happen to live under adapters/: xometryOffers type guards,
  // xometryConstraints locators, persistentProfileLock, portal definitions.
  "worker/src/jev/operationalEvidence.ts",
  "worker/src/jev/quoteDocument.ts",
  "worker/src/jev/relevanceProjection.ts",
  "worker/src/providerCapabilityCanaryRuntime.ts",
  "worker/src/runtimeSecrets.ts",
  "worker/src/xometryAuthProbe.ts",
  "worker/src/xometryProfileExport.ts",
  // Operator CLIs and offline recovery tooling. They run the portal kernel or
  // adapter registry outside the request path.
  "worker/src/recovery/comparison.ts",
  "worker/src/tools/liveHarnessArtifacts.ts",
  "worker/src/tools/probeXometryProfileAuth.ts",
  "worker/src/tools/sendcutsendAuth.ts",
  "worker/src/tools/vendorAuth.ts",
  "worker/src/tools/vendorWorkflowSmoke.ts",
  "worker/src/tools/xometryAuth.ts",
  "worker/src/tools/xometryQuantitySweep.ts",
];

// CertifiedProviderId does not exist yet. Until certify() lands, no file may
// assert it; that PR adds its allowlist module as the one exemption.
const CERTIFIED_PROVIDER_ID_CAST = {
  selector:
    ":matches(TSAsExpression, TSTypeAssertion) > TSTypeReference.typeAnnotation[typeName.name='CertifiedProviderId']",
  message: "Only the provider allowlist module may produce a CertifiedProviderId. Use certify(). See OVD-874.",
};

export default tseslint.config(
  {
    ignores: [
      "dist",
      "worker/dist",
      "**/.next",
      "**/.next/**",
      ".claude/**",
      ".stoneforge/**",
      ".agents/**",
      ".turbo/**",
      ".vercel/**",
      ".code-review-graph/**",
      // verify-overdrafter evidence (gitignored; holds bundled vite caches).
      "artifacts/verify-overdrafter/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-restricted-imports": [
        "warn",
        { patterns: [{ ...ADAPTER_IMPORT_PATTERN, allowTypeImports: true }] },
      ],
      "no-restricted-syntax": ["warn", CERTIFIED_PROVIDER_ID_CAST],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    rules: {
      "no-restricted-imports": ["warn", { patterns: [ADAPTER_IMPORT_PATTERN] }],
    },
  },
  {
    files: ADAPTER_IMPORT_ALLOWLIST,
    rules: {
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
  {
    files: ["src/components/ui/**/*.{ts,tsx}", "src/components/debug/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["api/**/*.ts", "server/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
