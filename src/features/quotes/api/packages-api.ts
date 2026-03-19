import { supabase } from "@/integrations/supabase/client";
import type {
  ClientPackageAggregate,
  ManualQuoteArtifactInput,
  ManualQuoteOfferInput,
  ManualQuoteRecordResult,
  PublishedQuotePackageRecord,
} from "@/features/quotes/types";
import type { VendorName, VendorStatus } from "@/integrations/supabase/types";
import type {
  ClientSelectionRecord,
  JobRecord,
  PublishedQuoteOptionRecord,
} from "@/features/quotes/types";
import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export async function fetchPublishedPackagesByOrganization(
  organizationId: string,
): Promise<PublishedQuotePackageRecord[]> {
  const { data, error } = await supabase
    .from("published_quote_packages")
    .select("*")
    .eq("organization_id", organizationId)
    .order("published_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchPublishedPackagesByJobIds(
  jobIds: string[],
): Promise<PublishedQuotePackageRecord[]> {
  if (jobIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("published_quote_packages")
    .select("*")
    .in("job_id", jobIds)
    .order("published_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchClientPackage(packageId: string): Promise<ClientPackageAggregate> {
  const { data: packageData, error: packageError } = await supabase
    .from("published_quote_packages")
    .select("*")
    .eq("id", packageId)
    .single();

  const pkg = ensureData(packageData as PublishedQuotePackageRecord | null, packageError);

  const [jobResult, optionsResult, selectionResult] = await Promise.all([
    supabase.from("jobs").select("*").eq("id", pkg.job_id).single(),
    supabase
      .from("published_quote_options")
      .select("*")
      .eq("package_id", packageId)
      .order("requested_quantity", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("client_selections")
      .select("*")
      .eq("package_id", packageId)
      .order("created_at", { ascending: false }),
  ]);

  return {
    package: pkg,
    job: ensureData(jobResult.data, jobResult.error) as JobRecord,
    options: ensureData(optionsResult.data, optionsResult.error) as PublishedQuoteOptionRecord[],
    selections: ensureData(selectionResult.data, selectionResult.error) as ClientSelectionRecord[],
  };
}

export async function publishQuotePackage(input: {
  jobId: string;
  quoteRunId: string;
  clientSummary?: string;
  force?: boolean;
}): Promise<string> {
  const { data, error } = await callRpc("api_publish_quote_package", {
    p_job_id: input.jobId,
    p_quote_run_id: input.quoteRunId,
    p_client_summary: input.clientSummary ?? null,
    p_force: Boolean(input.force),
  });

  return ensureData(data, error);
}

export async function recordManualVendorQuote(input: {
  jobId: string;
  partId: string;
  vendor: VendorName;
  status?: VendorStatus;
  summaryNote?: string;
  sourceText?: string;
  quoteUrl?: string;
  offers: ManualQuoteOfferInput[];
  artifacts?: ManualQuoteArtifactInput[];
}): Promise<ManualQuoteRecordResult> {
  const { data, error } = await callRpc("api_record_manual_vendor_quote", {
    p_job_id: input.jobId,
    p_part_id: input.partId,
    p_vendor: input.vendor,
    p_status: input.status ?? "official_quote_received",
    p_summary_note: input.summaryNote ?? null,
    p_source_text: input.sourceText ?? null,
    p_quote_url: input.quoteUrl ?? null,
    p_offers: input.offers,
    p_artifacts: input.artifacts ?? [],
  });

  return ensureData(data, error) as ManualQuoteRecordResult;
}

export async function selectQuoteOption(input: {
  packageId: string;
  optionId: string;
  note?: string;
}): Promise<string> {
  const { data, error } = await callRpc("api_select_quote_option", {
    p_package_id: input.packageId,
    p_option_id: input.optionId,
    p_note: input.note ?? null,
  });

  return ensureData(data, error);
}
