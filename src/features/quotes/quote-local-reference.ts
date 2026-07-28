const QUOTE_REFERENCE_PREFIX = "overdrafter:quote-reference:";
const QUOTE_REFERENCE_CHANGED_EVENT = "overdrafter:quote-reference-changed";
export const MAX_QUOTE_REFERENCE_LENGTH = 80;

export type QuoteReferenceChangeDetail = {
  jobId: string;
  reference: string | null;
};

function getStorageKey(jobId: string): string {
  return `${QUOTE_REFERENCE_PREFIX}${jobId}`;
}

export function normalizeQuoteReference(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return null;
  }

  return normalized.slice(0, MAX_QUOTE_REFERENCE_LENGTH);
}

export function readQuoteReference(jobId: string): string | null {
  if (typeof window === "undefined" || !jobId) {
    return null;
  }

  return normalizeQuoteReference(window.localStorage.getItem(getStorageKey(jobId)) ?? "");
}

export function writeQuoteReference(jobId: string, value: string): string | null {
  const reference = normalizeQuoteReference(value);

  if (typeof window === "undefined" || !jobId) {
    return reference;
  }

  if (reference) {
    window.localStorage.setItem(getStorageKey(jobId), reference);
  } else {
    window.localStorage.removeItem(getStorageKey(jobId));
  }

  window.dispatchEvent(
    new CustomEvent<QuoteReferenceChangeDetail>(QUOTE_REFERENCE_CHANGED_EVENT, {
      detail: {
        jobId,
        reference,
      },
    }),
  );

  return reference;
}

export function subscribeToQuoteReferenceChanges(
  listener: (detail: QuoteReferenceChangeDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleChange = (event: Event) => {
    const customEvent = event as CustomEvent<QuoteReferenceChangeDetail>;

    if (customEvent.detail?.jobId) {
      listener(customEvent.detail);
    }
  };

  window.addEventListener(QUOTE_REFERENCE_CHANGED_EVENT, handleChange);
  return () => window.removeEventListener(QUOTE_REFERENCE_CHANGED_EVENT, handleChange);
}
