/** Pending queries have no data yet, including when their fetch is paused offline. */
export function areQuoteOptionsLoading(
  jobsQuery: { isPending: boolean },
  workspaceQuery: { isPending: boolean },
  jobCount: number,
): boolean {
  return jobsQuery.isPending || (jobCount > 0 && workspaceQuery.isPending);
}
