import type {
  ClientQuoteSelectionOption,
  QuotePreset,
} from "@/features/quotes/selection";
import type {
  JobPartSummary,
  JobRecord,
  PartAggregate,
} from "@/features/quotes/types";
import { normalizeDrawingExtraction } from "@/features/quotes/utils";

export type ClientWorkspaceStateTone = "ready" | "warning" | "blocked";

export type ClientWorkspaceStateReason = {
  id: string;
  tone: ClientWorkspaceStateTone;
  label: string;
  detail: string;
};

export type ClientWorkspaceSelectionState = {
  tone: ClientWorkspaceStateTone;
  label: string;
  detail: string;
};

export type ClientWorkspaceState = {
  tone: ClientWorkspaceStateTone;
  label: string;
  detail: string;
  selection: ClientWorkspaceSelectionState;
  reasons: ClientWorkspaceStateReason[];
  counts: {
    eligibleOptions: number;
    selectableOptions: number;
    failedQuoteLanes: number;
    followUpQuoteLanes: number;
    dueDateBlockedOptions: number;
    excludedOptions: number;
    extractionWarnings: number;
  };
};

export type ClientQuoteOptionStateReason = {
  id: "needs_review" | "excluded" | "late" | "not_domestic";
  tone: ClientWorkspaceStateTone;
  label: string;
};

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeSelectedSupplier(summary: JobPartSummary | null | undefined) {
  if (!summary?.selectedSupplier) {
    return null;
  }

  return `${summary.selectedSupplier}${summary.selectedPriceUsd === null ? "" : " selected"}`;
}

function summarizeQuoteStatus(job: JobRecord): ClientWorkspaceSelectionState {
  switch (job.status) {
    case "extracting":
      return {
        tone: "ready",
        label: "Processing in background",
        detail: "Extraction and preview generation are running, but this part is already available to review.",
      };
    case "needs_spec_review":
      return {
        tone: "ready",
        label: "Ready for quote prep",
        detail: "Extraction finished and OverDrafter is applying the part data for quoting.",
      };
    case "ready_to_quote":
      return {
        tone: "ready",
        label: "Quote prep complete",
        detail: "This part is ready for the next quote step.",
      };
    case "quoting":
      return {
        tone: "warning",
        label: "Quotes in progress",
        detail: "Quote responses are still being collected.",
      };
    case "awaiting_vendor_manual_review":
      return {
        tone: "warning",
        label: "Vendor follow-up in progress",
        detail: "A quote lane still needs manual follow-up before all responses are settled.",
      };
    case "internal_review":
      return {
        tone: "warning",
        label: "Preparing package",
        detail: "OverDrafter is reviewing quotes before the package is finalized.",
      };
    case "published":
      return {
        tone: "ready",
        label: "Ready for review",
        detail: "A client-facing quote package is available to review.",
      };
    case "client_selected":
      return {
        tone: "ready",
        label: "Selection submitted",
        detail: "A quote option has already been selected for this line item.",
      };
    case "closed":
      return {
        tone: "ready",
        label: "Closed",
        detail: "This line item is no longer active.",
      };
    case "uploaded":
    default:
      return {
        tone: "ready",
        label: "Upload received",
        detail: "Files are available now while OverDrafter prepares previews and quote data in the background.",
      };
  }
}

function getRequestedByDate(input: {
  requestedByDate?: string | null;
  job: JobRecord;
  summary?: JobPartSummary | null;
}) {
  return input.requestedByDate ?? input.summary?.requestedByDate ?? input.job.requested_by_date ?? null;
}

export function getClientQuoteOptionStateReasons(input: {
  option: ClientQuoteSelectionOption;
  requestedByDate?: string | null;
  preset?: QuotePreset | null;
}): ClientQuoteOptionStateReason[] {
  const reasons: ClientQuoteOptionStateReason[] = [];
  const requestedByDate = input.requestedByDate ?? null;

  if (!input.option.isSelectable) {
    reasons.push({
      id: "needs_review",
      tone: "blocked",
      label: "Needs review before selection",
    });
  }

  if (requestedByDate && !input.option.dueDateEligible) {
    reasons.push({
      id: "late",
      tone: "warning",
      label: `Misses requested date ${requestedByDate}`,
    });
  }

  if (input.option.excluded) {
    reasons.push({
      id: "excluded",
      tone: "warning",
      label: "Excluded from presets",
    });
  }

  if (input.preset === "domestic" && input.option.domesticStatus !== "domestic") {
    reasons.push({
      id: "not_domestic",
      tone: "warning",
      label: "Not eligible for Domestic preset",
    });
  }

  return reasons;
}

export function describeClientPresetUnavailableReason(input: {
  options: readonly ClientQuoteSelectionOption[];
  preset: QuotePreset;
  requestedByDate?: string | null;
}): string {
  const requestedByDate = input.requestedByDate ?? null;
  const selectableOptions = input.options.filter((option) => option.isSelectable);
  const eligibleOptions = input.options.filter((option) => option.eligible);
  const dueDateBlockedOptions = input.options.filter(
    (option) => requestedByDate !== null && option.isSelectable && !option.dueDateEligible,
  );
  const excludedOptions = input.options.filter((option) => option.excluded);
  const domesticReadyOptions = eligibleOptions.filter((option) => option.domesticStatus === "domestic");

  if (requestedByDate && dueDateBlockedOptions.length > 0 && eligibleOptions.length === 0) {
    return `No quote currently meets the requested date of ${requestedByDate}.`;
  }

  if (input.preset === "domestic" && eligibleOptions.length > 0 && domesticReadyOptions.length === 0) {
    return "No domestic quote is ready for this preset.";
  }

  if (selectableOptions.length === 0 && input.options.length > 0) {
    return "Quote responses need review before this preset can apply.";
  }

  if (excludedOptions.length === input.options.length && input.options.length > 0) {
    return "All current quote lanes are excluded from presets.";
  }

  return input.preset === "domestic"
    ? "No domestic quote is available for this preset."
    : "No eligible quote is available for this preset.";
}

export function buildClientWorkspaceState(input: {
  job: JobRecord;
  summary?: JobPartSummary | null;
  part?: PartAggregate | null;
  options?: readonly ClientQuoteSelectionOption[];
  selectedOption?: ClientQuoteSelectionOption | null;
  requestedByDate?: string | null;
  requireSelection?: boolean;
}): ClientWorkspaceState {
  const summary = input.summary ?? null;
  const part = input.part ?? null;
  const options = input.options ?? [];
  const requestedByDate = getRequestedByDate({
    requestedByDate: input.requestedByDate,
    job: input.job,
    summary,
  });
  const extractionWarnings = part
    ? normalizeDrawingExtraction(part.extraction, part.id).warnings.length
    : 0;
  const failedQuoteLanes = part?.vendorQuotes.filter((quote) => quote.status === "failed").length ?? 0;
  const followUpQuoteLanes =
    part?.vendorQuotes.filter(
      (quote) =>
        quote.status === "manual_review_pending" || quote.status === "manual_vendor_followup",
    ).length ?? 0;
  const dueDateBlockedOptions = options.filter(
    (option) => requestedByDate !== null && !option.dueDateEligible,
  ).length;
  const selectableOptions = options.filter((option) => option.isSelectable).length;
  const eligibleOptions = options.filter((option) => option.eligible).length;
  const excludedOptions = options.filter((option) => option.excluded).length;
  const reasons: ClientWorkspaceStateReason[] = [];

  if (extractionWarnings > 0) {
    reasons.push({
      id: "extraction-warning",
      tone: "warning",
      label: `${pluralize(extractionWarnings, "extraction warning")} need review`,
      detail: "Review extracted material, finish, revision, and notes before relying on the quote options.",
    });
  }

  if (failedQuoteLanes > 0) {
    reasons.push({
      id: "quote-failure",
      tone: options.length > 0 ? "warning" : "blocked",
      label: `${pluralize(failedQuoteLanes, "quote lane")} failed`,
      detail:
        options.length > 0
          ? "Some quote options are still available, but at least one lane could not return a usable quote."
          : "No usable quote is available from the failed lane yet.",
    });
  }

  if (followUpQuoteLanes > 0) {
    reasons.push({
      id: "quote-follow-up",
      tone: "warning",
      label: `${pluralize(followUpQuoteLanes, "quote lane")} still need follow-up`,
      detail: "A manual vendor follow-up is still in progress for at least one quote lane.",
    });
  }

  if (requestedByDate && dueDateBlockedOptions > 0) {
    reasons.push({
      id: "due-date-filter",
      tone: eligibleOptions > 0 ? "warning" : "blocked",
      label:
        eligibleOptions > 0
          ? `${pluralize(dueDateBlockedOptions, "option")} miss ${requestedByDate}`
          : `No quote currently meets ${requestedByDate}`,
      detail:
        eligibleOptions > 0
          ? `${pluralize(eligibleOptions, "option")} still match the requested date.`
          : "Adjust the requested date or wait for another quote response.",
    });
  }

  if (excludedOptions > 0) {
    reasons.push({
      id: "vendor-exclusion",
      tone: eligibleOptions > 0 ? "warning" : "blocked",
      label: `${pluralize(excludedOptions, "vendor lane")} excluded from presets`,
      detail: "Excluded lanes stay visible, but preset ranking and bulk apply skip them.",
    });
  }

  if (options.length > 0 && selectableOptions === 0) {
    reasons.push({
      id: "selection-not-ready",
      tone: "blocked",
      label: "Quote responses need review before selection",
      detail: "These quote responses are visible, but they are not ready to select yet.",
    });
  }

  if (part && options.length === 0 && !part.cadFile && !summary?.selectedSupplier) {
    reasons.push({
      id: "cad-missing",
      tone: "warning",
      label: "CAD file needed for quote comparison",
      detail: "Upload a CAD file before this part can move into quote comparison.",
    });
  }

  const selectedFallback = summarizeSelectedSupplier(summary);
  const selection = (() => {
    if (input.selectedOption) {
      return {
        tone:
          requestedByDate && !input.selectedOption.dueDateEligible ? "warning" : "ready",
        label: "Quote selected",
        detail:
          requestedByDate && !input.selectedOption.dueDateEligible
            ? "The current selection misses the requested date."
            : "This line item already has a selected quote option.",
      } satisfies ClientWorkspaceSelectionState;
    }

    if (selectedFallback) {
      return {
        tone: "ready",
        label: "Quote selected",
        detail: selectedFallback,
      } satisfies ClientWorkspaceSelectionState;
    }

    if (input.requireSelection && eligibleOptions > 0) {
      return {
        tone: "blocked",
        label: "Selection needed",
        detail: `${pluralize(eligibleOptions, "eligible option")} are ready to choose from.`,
      } satisfies ClientWorkspaceSelectionState;
    }

    if (eligibleOptions > 0) {
      return {
        tone: "ready",
        label: "Ready to select",
        detail: `${pluralize(eligibleOptions, "eligible option")} are ready to compare.`,
      } satisfies ClientWorkspaceSelectionState;
    }

    if (options.length > 0) {
      return {
        tone: "blocked",
        label: "Selection blocked",
        detail:
          requestedByDate && dueDateBlockedOptions > 0
            ? `No eligible quote currently meets the requested date of ${requestedByDate}.`
            : "No eligible quote option is ready to select yet.",
      } satisfies ClientWorkspaceSelectionState;
    }

    return summarizeQuoteStatus(input.job);
  })();

  const tone: ClientWorkspaceStateTone = reasons.some((reason) => reason.tone === "blocked") ||
    selection.tone === "blocked"
    ? "blocked"
    : reasons.some((reason) => reason.tone === "warning") || selection.tone === "warning"
      ? "warning"
      : "ready";

  return {
    tone,
    label: tone === "ready" ? "Ready" : tone === "warning" ? "Warning" : "Blocked",
    detail: selection.detail,
    selection,
    reasons,
    counts: {
      eligibleOptions,
      selectableOptions,
      failedQuoteLanes,
      followUpQuoteLanes,
      dueDateBlockedOptions,
      excludedOptions,
      extractionWarnings,
    },
  };
}

export function summarizeClientWorkspaceStates(states: readonly ClientWorkspaceState[]) {
  return states.reduce(
    (summary, state) => {
      summary[state.tone] += 1;
      return summary;
    },
    {
      ready: 0,
      warning: 0,
      blocked: 0,
    } satisfies Record<ClientWorkspaceStateTone, number>,
  );
}
