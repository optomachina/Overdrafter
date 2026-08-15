import { Link } from "react-router-dom";
import {
  FOUNDING_BETA_POLICY_EFFECTIVE_DATE,
  FOUNDING_BETA_POLICY_LINKS,
  FOUNDING_BETA_POLICY_REVISION,
  FOUNDING_BETA_SUPPORT_EMAIL,
  FOUNDING_BETA_SUPPORT_MAILTO,
} from "@/lib/founding-beta-policy";

type LegalPoliciesProps = {
  readonly policy: "terms" | "privacy";
};

type PolicySection = {
  heading: string;
  paragraphs: string[];
};

const termsSections: PolicySection[] = [
  {
    heading: "A controlled, invitation-only beta",
    paragraphs: [
      "The OverDrafter Founding Beta is free and invitation-only. Creating an account does not enroll you or authorize file uploads. Participation does not create a charge, order, purchase order, supplier commitment, service-level agreement, or promise of general availability.",
      "The beta is an evaluation program. Features may change, pause, or be withdrawn as OverDrafter learns from the initial cohort.",
    ],
  },
  {
    heading: "Your authority and eligible work",
    paragraphs: [
      "You must have authority to share every file and requirement you submit. You retain ownership of your content and give OverDrafter permission to use it only to operate the service, support you, and obtain the quotes you request.",
      "Do not submit ITAR, CUI, export-controlled, classified, weapons or firearms, medical-implant, life-safety, or other regulated work. OverDrafter 1.0 is not approved for those workloads.",
    ],
  },
  {
    heading: "Account responsibility",
    paragraphs: [
      `Keep your sign-in credentials secure, provide accurate account information, and promptly report suspected account compromise to ${FOUNDING_BETA_SUPPORT_EMAIL}. You are responsible for activity performed through your account until you report unauthorized access.`,
      "Use only the organization and files you are authorized to access. Do not attempt to bypass enrollment, organization isolation, upload controls, provider confirmations, or other service safeguards.",
    ],
  },
  {
    heading: "Quote requests and outside providers",
    paragraphs: [
      "Before any automatic quote request, OverDrafter will show the named provider, the files and requirements to be shared, and a confirmation step. A quote request is not an order. You decide whether to continue at the provider's official destination.",
      "Provider pricing, lead times, availability, and downstream terms come from that provider. OverDrafter does not promise that a provider will quote or manufacture a part.",
    ],
  },
  {
    heading: "Withdrawal, support, and incidents",
    paragraphs: [
      `You may withdraw from the beta or request deletion by emailing ${FOUNDING_BETA_SUPPORT_EMAIL}. OverDrafter will complete removal from active service systems within 30 days and allow isolated backup copies to age out within 90 days, except for the minimum records needed for security, fraud prevention, legal obligations, or documenting a request.`,
      `Report suspected security incidents to ${FOUNDING_BETA_SUPPORT_EMAIL}. OverDrafter will acknowledge an incident report within one Arizona business day, excluding United States federal holidays. This is an acknowledgment target, not a resolution-time guarantee or service-level agreement.`,
    ],
  },
];

const privacySections: PolicySection[] = [
  {
    heading: "What OverDrafter handles",
    paragraphs: [
      "OverDrafter handles account and organization details, uploaded CAD models and drawings, manufacturing requirements, quote results, and the operational records needed to run and secure the beta.",
      "Support diagnostics are kept in your browser until you choose to copy and share them. They can include your account identifier, email address, organization context, route, and recent application events. OverDrafter does not automatically upload that diagnostic report.",
    ],
  },
  {
    heading: "How information is used and shared",
    paragraphs: [
      "Information is used to authenticate you, store and review parts, operate the quoting workflow, troubleshoot problems, and prevent abuse. OverDrafter may use sanitized operational measurements and feedback to improve the beta. Uploaded files and their content are not used for model training, model evaluation, or product improvement without a separate, optional opt-in.",
      "Supabase supports authentication, database, and file-storage operations. When drawing extraction needs a configured model fallback, title-block or full-page drawing images, the filename, and parser context may be sent to OpenAI, Anthropic, or OpenRouter solely to extract manufacturing requirements for your request. The configured provider may vary by operation; this is service processing, not permission to train on or improve from your files.",
      "When you approve a manufacturing-provider disclosure, the named provider receives only the displayed files and requirements needed for that quote attempt. Other infrastructure providers may process limited service data to host, secure, and operate OverDrafter.",
    ],
  },
  {
    heading: "Access, retention, and deletion",
    paragraphs: [
      "Access is limited to authorized organization members and the operators who need it for service operation, security, or support. Diagnostic access is purpose-limited and should avoid unnecessary file contents or secrets.",
      `Email ${FOUNDING_BETA_SUPPORT_EMAIL} to request access help, correction, withdrawal, or deletion. OverDrafter will verify the requester, complete deletion from active service systems within 30 days, and allow isolated backups to age out within 90 days. A provider that already received an approved disclosure may retain its copy under its own policy; OverDrafter will identify that provider so you can direct any additional request appropriately.`,
    ],
  },
  {
    heading: "Security and contact",
    paragraphs: [
      `Send privacy, security, support, and withdrawal questions to ${FOUNDING_BETA_SUPPORT_EMAIL}. Suspected security incidents will be acknowledged within one Arizona business day, excluding United States federal holidays.`,
      "No internet service can guarantee absolute security. OverDrafter may preserve narrowly scoped audit or security records when needed to investigate abuse, honor legal obligations, or document a completed request.",
    ],
  },
];

function PolicyLink({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <Link className="font-medium text-primary underline-offset-4 hover:underline" to={href}>
      {children}
    </Link>
  );
}

export default function LegalPolicies({ policy }: LegalPoliciesProps) {
  const isTerms = policy === "terms";
  const title = isTerms ? "Founding Beta Terms" : "Privacy & data handling";
  const sections = isTerms ? termsSections : privacySections;

  return (
    <main className="min-h-svh bg-background px-5 py-10 text-foreground sm:px-8 sm:py-14">
      <article className="mx-auto max-w-3xl">
        <Link className="text-sm font-medium text-muted-foreground hover:text-foreground" to="/">
          ← OverDrafter
        </Link>
        <header className="mt-8 border-b border-border pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Founding Beta</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
          <dl className="mt-5 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <div><dt className="font-medium text-foreground">Revision</dt><dd>{FOUNDING_BETA_POLICY_REVISION}</dd></div>
            <div><dt className="font-medium text-foreground">Effective</dt><dd>{FOUNDING_BETA_POLICY_EFFECTIVE_DATE}</dd></div>
          </dl>
        </header>

        <div className="space-y-10 py-10">
          {sections.map((section) => (
            <section key={section.heading}>
              <h2 className="text-2xl font-semibold tracking-tight">{section.heading}</h2>
              <div className="mt-4 space-y-4 text-base leading-7 text-muted-foreground">
                {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              </div>
            </section>
          ))}
        </div>

        <footer className="border-t border-border py-8 text-sm leading-6 text-muted-foreground">
          <p>
            {isTerms ? (
              <>Also read the <PolicyLink href={FOUNDING_BETA_POLICY_LINKS.privacy}>Privacy & data handling notice</PolicyLink>.</>
            ) : (
              <>Also read the <PolicyLink href={FOUNDING_BETA_POLICY_LINKS.terms}>Founding Beta Terms</PolicyLink>.</>
            )}
          </p>
          <p className="mt-3">Questions?{" "}<a className="font-medium text-primary underline-offset-4 hover:underline" href={FOUNDING_BETA_SUPPORT_MAILTO}>{FOUNDING_BETA_SUPPORT_EMAIL}</a></p>
        </footer>
      </article>
    </main>
  );
}
