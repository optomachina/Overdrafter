import { useEffect, useMemo, useState } from "react";
import {
  readQuoteReference,
  subscribeToQuoteReferenceChanges,
} from "@/features/quotes/quote-local-reference";

export function useQuoteReferences(jobIds: readonly string[]): ReadonlyMap<string, string> {
  const jobIdsKey = [...jobIds].sort((left, right) => left.localeCompare(right)).join("|");
  const stableJobIds = useMemo(
    () => (jobIdsKey.length > 0 ? jobIdsKey.split("|") : []),
    [jobIdsKey],
  );
  const [, setVersion] = useState(0);

  useEffect(
    () =>
      subscribeToQuoteReferenceChanges(({ jobId }) => {
        if (stableJobIds.includes(jobId)) {
          setVersion((current) => current + 1);
        }
      }),
    [stableJobIds],
  );

  const references = new Map<string, string>();

  stableJobIds.forEach((jobId) => {
    const reference = readQuoteReference(jobId);
    if (reference) {
      references.set(jobId, reference);
    }
  });

  return references;
}
