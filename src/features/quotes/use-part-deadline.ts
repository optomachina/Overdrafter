import { useQuery } from "@tanstack/react-query";
import { fetchPartDeadline, type PartDeadline } from "@/features/quotes/api/part-deadline-api";
import { isFixtureModeEnabled } from "@/features/quotes/client-workspace-fixtures";

/**
 * Reads the persisted OVD-570 part deadline intent. Fixture mode has no RPC
 * backend, and a failed read degrades to the recorded need-by date instead of
 * blocking the comparison.
 */
export function usePartDeadline(partId: string | null | undefined): PartDeadline | null {
  const query = useQuery({
    queryKey: ["part-deadline", partId],
    queryFn: () => fetchPartDeadline(partId as string),
    enabled: Boolean(partId) && !isFixtureModeEnabled(),
    retry: false,
    staleTime: 60_000,
  });
  return query.data ?? null;
}
