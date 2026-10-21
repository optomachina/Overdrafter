type QueryLoadState = { isPending: boolean; fetchStatus: "fetching" | "paused" | "idle" };

/**
 * No data yet and a fetch is running or paused offline. A disabled query is also
 * pending but idle, and never fetches, so it does not count as loading.
 */
function isAwaitingFirstData(query: QueryLoadState): boolean {
  return query.isPending && query.fetchStatus !== "idle";
}

export function areQuoteOptionsLoading(jobsQuery: QueryLoadState, workspaceQuery: QueryLoadState): boolean {
  return isAwaitingFirstData(jobsQuery) || isAwaitingFirstData(workspaceQuery);
}
