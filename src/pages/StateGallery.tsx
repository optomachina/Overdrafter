import type { ReactNode } from "react";
import {
  ArrowUpRight,
  BadgeAlert,
  Lock,
  MonitorSmartphone,
  PanelsTopLeft,
  Route,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { ClientExtractionStatusNotice } from "@/components/quotes/ClientExtractionStatusNotice";
import { ClientDrawingPreviewPanel } from "@/components/quotes/ClientQuoteAssetPanels";
import { ManualQuoteIntakeCard } from "@/components/quotes/ManualQuoteIntakeCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClientExtractionDiagnostics, DrawingPreviewData, PartAggregate } from "@/features/quotes/types";
import { isFixtureModeAvailable } from "@/features/quotes/client-workspace-fixtures";
import NotFound from "@/pages/NotFound";
import { buildEmbeddedPreviewHref } from "@/pages/state-gallery-preview";

type PreviewCard = {
  title: string;
  description: string;
  href: string;
  label: string;
};

type GallerySectionLink = {
  id: string;
  label: string;
  description: string;
};

const workspaceCards: PreviewCard[] = [
  {
    title: "Guest landing",
    description: "Anonymous client landing state with intake CTA and auth entry points.",
    href: "/?fixture=landing-anonymous&debug=1",
    label: "Workspace",
  },
  {
    title: "Client empty workspace",
    description: "Signed-in client with no parts or projects yet.",
    href: "/?fixture=client-empty&debug=1",
    label: "Workspace",
  },
];

const partDetailCards: PreviewCard[] = [
  {
    title: "Needs attention part",
    description: "Part detail state with extraction or request cleanup still needed before quoting can proceed.",
    href: "/parts/fx-job-needs-attention?fixture=client-needs-attention&debug=1",
    label: "Part detail",
  },
];

const projectCards: PreviewCard[] = [
  {
    title: "Quoted project",
    description: "Project workspace with comparable vendor offers and a client-visible quote state.",
    href: "/projects/fx-project-quoted?fixture=client-quoted&debug=1",
    label: "Project",
  },
  {
    title: "Published review",
    description: "Review-ready project state after publication for downstream client signoff.",
    href: "/projects/fx-project-published/review?fixture=client-published&debug=1",
    label: "Project review",
  },
];

const EMPTY_DRAWING_PREVIEW: DrawingPreviewData = {
  pageCount: 0,
  thumbnail: null,
  pages: [],
};

const EXTRACTION_QUEUED: ClientExtractionDiagnostics = {
  lifecycle: "queued",
  warningCount: 0,
  warnings: [],
  missingFields: [],
  lastFailureCode: null,
  lastFailureMessage: null,
  extractedAt: null,
  failedAt: null,
  updatedAt: "2026-03-16T09:00:00.000Z",
  pageCount: 2,
  hasCadFile: true,
  hasDrawingFile: true,
};

const EXTRACTION_PARTIAL: ClientExtractionDiagnostics = {
  lifecycle: "partial",
  warningCount: 2,
  warnings: ["No revision block found.", "Tolerance callout could not be normalized."],
  missingFields: ["partNumber", "tightestToleranceInch"],
  lastFailureCode: null,
  lastFailureMessage: null,
  extractedAt: "2026-03-16T09:04:00.000Z",
  failedAt: null,
  updatedAt: "2026-03-16T09:04:00.000Z",
  pageCount: 3,
  hasCadFile: true,
  hasDrawingFile: true,
};

const EXTRACTION_FAILED: ClientExtractionDiagnostics = {
  lifecycle: "failed",
  warningCount: 0,
  warnings: [],
  missingFields: [],
  lastFailureCode: "pdf_parse_failed",
  lastFailureMessage: "The uploaded drawing could not be parsed into a usable page model.",
  extractedAt: null,
  failedAt: "2026-03-16T09:08:00.000Z",
  updatedAt: "2026-03-16T09:08:00.000Z",
  pageCount: 1,
  hasCadFile: true,
  hasDrawingFile: true,
};

const MANUAL_QUOTE_PARTS: PartAggregate[] = [
  {
    id: "gallery-part-1",
    job_id: "gallery-job-1",
    organization_id: "gallery-org-1",
    name: "Manifold body",
    normalized_key: "manifold-body",
    cad_file_id: null,
    drawing_file_id: null,
    quantity: 12,
    created_at: "2026-03-16T09:00:00.000Z",
    updated_at: "2026-03-16T09:00:00.000Z",
    approvedRequirement: {
      id: "gallery-approved-1",
      job_id: "gallery-job-1",
      part_id: "gallery-part-1",
      description: "5-axis aluminum manifold body",
      part_number: "MF-2048",
      revision: "B",
      material: "6061-T6 Aluminum",
      finish: "As machined",
      tightest_tolerance_inch: 0.002,
      process: "CNC milling",
      notes: null,
      quantity: 12,
      requested_quote_quantities: [12, 24],
      requested_by_date: "2026-03-28",
      created_at: "2026-03-16T09:00:00.000Z",
      updated_at: "2026-03-16T09:00:00.000Z",
      requested_service_kinds: ["manufacturing_quote"],
      primary_service_kind: "manufacturing_quote",
      service_notes: null,
      shipping_priority: null,
      ship_to_region: null,
      shipping_constraints_notes: null,
      required_certifications: [],
      traceability_required: null,
      inspection_level: null,
      certification_notes: null,
      region_preference: null,
      supplier_selection_mode: null,
      allow_split_award: null,
      sourcing_notes: null,
      release_status: null,
      review_disposition: null,
      review_owner: null,
      release_notes: null,
    },
    cadFile: null,
    drawingFile: null,
    extraction: null,
    clientRequirement: null,
    clientExtraction: null,
    vendorQuotes: [],
  } as unknown as PartAggregate,
];

const gallerySections: GallerySectionLink[] = [
  {
    id: "gallery-auth-states",
    label: "Auth",
    description: "Sign-up, recovery, verification, and invalid-session states.",
  },
  {
    id: "gallery-workspace-states",
    label: "Workspace",
    description: "Guest and signed-in entry states backed by fixtures.",
  },
  {
    id: "gallery-part-project-states",
    label: "Part + Project",
    description: "Primary route-backed workspace destinations after intake.",
  },
  {
    id: "gallery-part-failure-states",
    label: "Part Failures",
    description: "Extraction and drawing-preview edge cases.",
  },
  {
    id: "gallery-internal-ops",
    label: "Internal Ops",
    description: "Estimator triage, manual quote intake, and publish holds.",
  },
  {
    id: "gallery-access-errors",
    label: "Errors",
    description: "Permissions, invite failures, compatibility, and app errors.",
  },
];

function SectionShell({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[36px] border border-white/10 bg-black/18 p-5 backdrop-blur-xl sm:p-6">
      <div className="flex items-start gap-4">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/10 bg-white/6 text-white/85">
          {icon}
        </div>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-white">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">{description}</p>
        </div>
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function GalleryPanelCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[30px] border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <div className="mb-5">
        <p className="text-xs font-medium uppercase tracking-[0.24em] text-white/38">{title}</p>
        <p className="mt-2 text-sm leading-6 text-white/58">{description}</p>
      </div>
      {children}
    </div>
  );
}

function StateMessageCard({
  title,
  description,
  tone = "neutral",
}: {
  title: string;
  description: string;
  tone?: "neutral" | "warning" | "danger";
}) {
  const toneClass =
    tone === "warning"
      ? "border-amber-400/20 bg-amber-500/10"
      : tone === "danger"
        ? "border-rose-400/20 bg-rose-500/10"
        : "border-white/10 bg-white/[0.04]";

  return (
    <article className={`rounded-[28px] border p-5 ${toneClass}`}>
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-white/65">{description}</p>
    </article>
  );
}

function RoutePreviewCard({ card }: { card: PreviewCard }) {
  return (
    <article className="overflow-hidden rounded-[30px] border border-white/10 bg-[#08111c]/90 shadow-[0_26px_70px_rgba(0,0,0,0.28)]">
      <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-white/38">{card.label}</p>
          <h3 className="mt-2 text-lg font-semibold text-white">{card.title}</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/58">{card.description}</p>
        </div>
        <Button
          asChild
          type="button"
          variant="outline"
          className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/8"
        >
          <a href={card.href} target="_blank" rel="noreferrer">
            Open
            <ArrowUpRight className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </div>
      <div className="bg-[#020617] p-3">
        <iframe
          title={card.title}
          src={buildEmbeddedPreviewHref(card.href)}
          className="h-[640px] w-full rounded-[22px] border border-white/8 bg-[#020617]"
          loading="lazy"
        />
      </div>
    </article>
  );
}

const StateGallery = () => {
  if (!isFixtureModeAvailable()) {
    return <NotFound />;
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.12),transparent_24%),linear-gradient(180deg,#1f2024_0%,#1a1b1f_44%,#12151b_100%)] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-[1680px]">
        <aside className="sticky top-0 hidden h-screen w-[21rem] shrink-0 border-r border-white/6 bg-[#16181c]/94 backdrop-blur md:flex md:flex-col">
          <div className="border-b border-white/8 px-5 py-5">
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.06]">
                <PanelsTopLeft className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-white/70">OverDrafter</p>
                <p className="font-semibold tracking-tight text-white">State Gallery</p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-white/55">
              Deterministic UI surfaces for review, implementation, and Figma capture.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-5">
            <nav className="space-y-2">
              {gallerySections.map((section) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  className="block rounded-[22px] border border-white/8 bg-white/[0.04] px-4 py-4 text-white transition hover:bg-white/[0.08]"
                >
                  <p className="text-sm font-semibold">{section.label}</p>
                  <p className="mt-1 text-xs leading-5 text-white/52">{section.description}</p>
                </a>
              ))}
            </nav>

            <div className="mt-6 rounded-[24px] border border-white/8 bg-black/20 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-white/38">Usage</p>
              <p className="mt-3 text-sm leading-6 text-white/58">
                Run `npm run dev`, then use the bottom-right `Fixtures` launcher or open
                ` /debug/state-gallery` directly.
              </p>
            </div>
          </div>
        </aside>

        <div className="flex min-h-screen flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-white/8 bg-[#111214]/88 backdrop-blur-xl">
            <div className="px-5 py-5 sm:px-8">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-white/40">State gallery</p>
              <h1 className="mt-2 text-3xl font-medium tracking-tight text-white sm:text-4xl">
                Review OverDrafter states without hunting through flows
              </h1>
              <p className="mt-3 max-w-4xl text-sm leading-6 text-white/58">
                Auth, workspace, part, project, internal-ops, and failure states are grouped into direct
                navigation sections so the page behaves more like an OverDrafter workspace than a long
                document.
              </p>
            </div>
          </header>

          <div className="border-b border-white/6 bg-[#17191d]/92 px-5 py-4 md:hidden">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {gallerySections.map((section) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-white/75"
                >
                  {section.label}
                </a>
              ))}
            </div>
          </div>

          <div className="px-5 py-6 sm:px-8 sm:py-8">
            <div className="space-y-8">
        <section className="rounded-[34px] border border-white/10 bg-[#202226]/92 p-6 shadow-[0_24px_70px_rgba(0,0,0,0.28)] sm:p-7">
          <div className="max-w-4xl">
            <p className="text-xs font-medium uppercase tracking-[0.32em] text-white/42">Local dev surface</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Fast access to high-value states
            </h2>
            <p className="mt-4 text-base leading-7 text-white/62">
              The gallery exists so you can jump straight to implementation and review surfaces instead of
              reproducing auth, upload, extraction, and publication paths every time.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 text-sm text-white/56">
              <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2">
                Available only in local dev or test builds
              </span>
              <span className="rounded-full border border-white/10 bg-white/6 px-4 py-2">
                Embedded previews hide the floating fixture and diagnostics launchers
              </span>
            </div>
          </div>
        </section>

        <div id="gallery-auth-states" className="scroll-mt-28">
        <SectionShell
          icon={<Lock className="h-5 w-5" />}
          title="Auth states"
          description="Inline auth panels render deterministic entry and recovery states without depending on live Supabase responses."
        >
          <div className="grid gap-6 xl:grid-cols-2">
            <GalleryPanelCard
              title="Sign up"
              description="Primary account creation panel with social auth and email fallback."
            >
              <AuthPanel initialMode="sign-up" />
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Verify email"
              description="Post-sign-up confirmation state shown when password auth is blocked until the inbox link is opened."
            >
              <section className="w-full rounded-[28px] border border-white/10 bg-[#0b0d10]/96 p-5 text-white shadow-[0_32px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:p-6">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-white/40">
                    Confirm your email
                  </p>
                  <h3 className="mt-3 text-2xl font-semibold tracking-tight">Email verification required</h3>
                  <p className="mt-2 text-sm leading-6 text-white/55">
                    Open the confirmation link from your inbox to finish setting up the account.
                  </p>
                </div>

                <div className="mt-5">
                  <EmailVerificationPrompt
                    email="procurement@fixture-machine.co"
                    onChangeEmail={() => undefined}
                    onRefreshSession={() => undefined}
                    onResend={() => undefined}
                  />
                </div>
              </section>
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Sign in"
              description="Standard credential entry with a route into password recovery."
            >
              <AuthPanel initialMode="sign-in" />
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Forgot password"
              description="Password reset request before the recovery email has been opened."
            >
              <AuthPanel initialMode="forgot-password" />
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Password recovery"
              description="Recovery session state for choosing a new password after following the email link."
            >
              <AuthPanel initialMode="update-password" />
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Invalid session"
              description="Recovery/auth storage is present locally but can no longer be trusted and the app has to reset to a clean signed-out state."
            >
              <StateMessageCard
                title="Session expired"
                tone="warning"
                description="Your stored session is no longer valid. Sign in again to keep working on uploads, quotes, and published packages."
              />
            </GalleryPanelCard>
          </div>
        </SectionShell>
        </div>

        <div id="gallery-workspace-states" className="scroll-mt-28">
        <SectionShell
          icon={<MonitorSmartphone className="h-5 w-5" />}
          title="Workspace states"
          description="These previews embed real routes backed by fixture mode so the gallery stays connected to production components and layout contracts."
        >
          <div className="grid gap-6 2xl:grid-cols-2">
            {workspaceCards.map((card) => (
              <RoutePreviewCard key={card.title} card={card} />
            ))}
          </div>
        </SectionShell>
        </div>

        <div id="gallery-part-project-states" className="scroll-mt-28">
        <SectionShell
          icon={<Route className="h-5 w-5" />}
          title="Part and project states"
          description="Part-detail and project-level review states are grouped here because they are the main workspace destinations after intake."
        >
          <div className="grid gap-6 2xl:grid-cols-2">
            {partDetailCards.concat(projectCards).map((card) => (
              <RoutePreviewCard key={card.title} card={card} />
            ))}
          </div>
        </SectionShell>
        </div>

        <div id="gallery-part-failure-states" className="scroll-mt-28">
        <SectionShell
          icon={<TriangleAlert className="h-5 w-5" />}
          title="Part failure states"
          description="These inline cards cover the harder-to-reproduce part-detail and artifact failure states that are still important for implementation and review."
        >
          <div className="grid gap-6 xl:grid-cols-2">
            <GalleryPanelCard
              title="Extraction lifecycle"
              description="Queued, partial, and failed extraction notices from the client part workflow."
            >
              <div className="space-y-4">
                <ClientExtractionStatusNotice diagnostics={EXTRACTION_QUEUED} />
                <ClientExtractionStatusNotice diagnostics={EXTRACTION_PARTIAL} />
                <ClientExtractionStatusNotice diagnostics={EXTRACTION_FAILED} />
              </div>
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Drawing preview failures"
              description="Missing, failed, and unavailable drawing preview states for artifact review."
            >
              <div className="space-y-5">
                <ClientDrawingPreviewPanel
                  drawingFile={null}
                  drawingPreview={EMPTY_DRAWING_PREVIEW}
                  state="missing"
                />
                <ClientDrawingPreviewPanel
                  drawingFile={null}
                  drawingPreview={EMPTY_DRAWING_PREVIEW}
                  state="failed"
                />
                <ClientDrawingPreviewPanel
                  drawingFile={null}
                  drawingPreview={EMPTY_DRAWING_PREVIEW}
                  state="unavailable"
                  statusMessage="Preview generation is unavailable in this environment until the drawing asset worker is reachable."
                />
              </div>
            </GalleryPanelCard>
          </div>
        </SectionShell>
        </div>

        <div id="gallery-internal-ops" className="scroll-mt-28">
        <SectionShell
          icon={<BadgeAlert className="h-5 w-5" />}
          title="Internal operations"
          description="Estimator-only review and manual intervention states are shown inline here so they stay available even without a seeded internal account."
        >
          <div className="grid gap-6 xl:grid-cols-2">
            <GalleryPanelCard
              title="Operations dashboard"
              description="High-level internal summary state for triage and publish readiness."
            >
              <div className="grid gap-4 md:grid-cols-3">
                <Card className="border-white/10 bg-white/5">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium text-white/70">In review</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-semibold text-white">6</p>
                    <p className="mt-2 text-sm text-white/55">Parts blocked on extraction or metadata cleanup.</p>
                  </CardContent>
                </Card>
                <Card className="border-white/10 bg-white/5">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium text-white/70">Quote runs active</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-semibold text-white">4</p>
                    <p className="mt-2 text-sm text-white/55">Awaiting vendor responses or follow-up.</p>
                  </CardContent>
                </Card>
                <Card className="border-white/10 bg-white/5">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium text-white/70">Ready to publish</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-3xl font-semibold text-white">2</p>
                    <p className="mt-2 text-sm text-white/55">Packages with curated offers ready for client release.</p>
                  </CardContent>
                </Card>
              </div>
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Manual quote intake"
              description="Estimator-side fallback when vendor automation is not the right path."
            >
              <ManualQuoteIntakeCard jobId="gallery-job-1" parts={MANUAL_QUOTE_PARTS} disabled />
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Publish failed"
              description="Internal publication guardrail when a package cannot be pushed client-side."
            >
              <StateMessageCard
                title="Package publish failed"
                tone="danger"
                description="The selected quote package could not be published because the latest compare set is missing a client-safe option map. Review pricing policy output and republish after the compare view is corrected."
              />
            </GalleryPanelCard>

            <GalleryPanelCard
              title="Email verification hold"
              description="Internal users can also be gated on verified email before sensitive actions are allowed."
            >
              <EmailVerificationPrompt
                email="estimator.fixture@example.com"
                onChangeEmail={() => undefined}
                onRefreshSession={() => undefined}
                onResend={() => undefined}
              />
            </GalleryPanelCard>
          </div>
        </SectionShell>
        </div>

        <div id="gallery-access-errors" className="scroll-mt-28">
        <SectionShell
          icon={<ShieldAlert className="h-5 w-5" />}
          title="Access and error states"
          description="Permission, invite, not-found, and compatibility failures belong in the gallery because they are expensive to reproduce and easy to regress."
        >
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            <StateMessageCard
              title="Permission denied"
              tone="danger"
              description="Your organization membership does not allow this action. Ask an internal admin to update access before editing project permissions or publishing packages."
            />
            <StateMessageCard
              title="Expired invite"
              tone="warning"
              description="This shared project invite has expired or has already been accepted. Request a fresh invite from the project owner to continue."
            />
            <StateMessageCard
              title="Resource not found"
              description="The requested project, part, or package could not be loaded. It may have been archived, deleted, or linked incorrectly."
            />
            <StateMessageCard
              title="Backend unavailable"
              tone="warning"
              description="Projects are unavailable in this environment until the shared workspace schema is applied. Retry after the required Supabase migrations are present."
            />
            <StateMessageCard
              title="Worker unavailable"
              tone="warning"
              description="Quote collection and drawing preview generation are blocked because the worker readiness probe is not healthy."
            />
            <StateMessageCard
              title="Unexpected application error"
              tone="danger"
              description="Use diagnostics capture when the UI falls into a non-recoverable state so support and engineering can reproduce the exact route, membership, and failing action."
            />
          </div>
        </SectionShell>
        </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};

export default StateGallery;
