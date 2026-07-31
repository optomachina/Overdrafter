import { useState, type Dispatch, type SetStateAction } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchAdminManualQuoteRequests,
  fetchManualQuoteOperatorAccess,
} from "@/features/quotes/api/manual-quote-admin-api";
import type {
  AdminManualQuoteRequest,
  AdminManualQuoteRequestPage,
  ManualQuoteOperatorAccess,
} from "@/features/quotes/api/manual-quote-admin-api";
import { formatStatusLabel } from "@/features/quotes/utils";

const PAGE_SIZE = 25;

function formatRequestAge(seconds: number): string {
  const minutes = Math.max(1, Math.floor(seconds / 60));

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 48) {
    return `${hours}h`;
  }

  return `${Math.floor(hours / 24)}d`;
}

function buildRequestHref(request: AdminManualQuoteRequest): string {
  const params = new URLSearchParams({
    quoteRequestId: request.requestId,
    quoteRunId: request.quoteRunId ?? "",
  });

  return `/internal/jobs/${request.jobId}?${params.toString()}`;
}

function InboxLoadingState() {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-2xl border border-dashed border-border">
      <Loader2
        className="h-5 w-5 animate-spin text-primary"
        aria-label="Loading manual quote requests"
      />
    </div>
  );
}

function InboxAuthorizationError() {
  return (
    <div
      className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
      role="alert"
    >
      Manual-request authorization could not be checked. Try again before using
      this queue.
    </div>
  );
}

function InboxUnauthorizedState() {
  return (
    <div className="rounded-2xl border border-border bg-accent p-5">
      <p className="font-medium text-foreground">Not authorized</p>
      <p className="mt-2 text-sm text-muted-foreground">
        A server-provisioned billing-admin capability is required to view manual
        requests.
      </p>
    </div>
  );
}

function InboxRequestError({
  error,
  onRetry,
}: Readonly<{
  error: Error | null;
  onRetry: () => void;
}>) {
  const message =
    error?.message ?? "Manual quote requests could not be loaded.";

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 p-4"
      role="alert"
    >
      <p className="text-sm text-destructive">{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RefreshCcw className="mr-2 h-4 w-4" />
        Retry
      </Button>
    </div>
  );
}

function InboxEmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-accent p-8 text-center">
      <p className="font-medium text-foreground">No active manual requests</p>
      <p className="mt-2 text-sm text-muted-foreground">
        New customer requests will appear here without creating vendor worker
        jobs.
      </p>
    </div>
  );
}

function RequestLifecycle({
  request,
}: Readonly<{
  request: AdminManualQuoteRequest;
}>) {
  return (
    <>
      <div className="flex max-w-72 flex-wrap gap-2">
        <Badge variant="outline">
          Request {formatStatusLabel(request.requestStatus)}
        </Badge>
        <Badge variant="outline">
          Run {formatStatusLabel(request.quoteRunStatus ?? "missing")}
        </Badge>
        <Badge variant="outline">
          Job {formatStatusLabel(request.jobStatus)}
        </Badge>
        {request.isStale ? (
          <Badge variant="destructive">Stale</Badge>
        ) : null}
      </div>
      {request.staleReason ? (
        <p className="mt-2 max-w-80 text-xs text-destructive">
          {request.staleReason}
        </p>
      ) : null}
    </>
  );
}

function RequestAction({
  request,
  fullWidth = false,
}: Readonly<{
  request: AdminManualQuoteRequest;
  fullWidth?: boolean;
}>) {
  return (
    <Button
      asChild
      variant={request.isStale ? "outline" : "default"}
      size="sm"
      className={fullWidth ? "w-full" : undefined}
    >
      <Link to={buildRequestHref(request)}>
        {request.isStale ? "Inspect" : "Complete"}
        <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
      </Link>
    </Button>
  );
}

function InboxRequestTable({
  requests,
}: Readonly<{
  requests: readonly AdminManualQuoteRequest[];
}>) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead>Organization</TableHead>
            <TableHead>Project / job</TableHead>
            <TableHead>Age</TableHead>
            <TableHead>Lifecycle</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map((request) => (
            <TableRow
              key={request.requestId}
              className="border-border align-top"
            >
              <TableCell>
                <p className="font-medium text-foreground">
                  {request.organizationName}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {request.requestedByEmail ?? "Requester email unavailable"}
                </p>
              </TableCell>
              <TableCell>
                <p className="font-medium text-foreground">
                  {request.projectName ?? "No project"}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {request.jobTitle}
                </p>
              </TableCell>
              <TableCell>
                <Badge variant="outline">
                  {formatRequestAge(request.requestAgeSeconds)}
                </Badge>
              </TableCell>
              <TableCell>
                <RequestLifecycle request={request} />
              </TableCell>
              <TableCell className="text-right">
                <RequestAction request={request} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function InboxRequestCards({
  requests,
}: Readonly<{
  requests: readonly AdminManualQuoteRequest[];
}>) {
  return (
    <ul
      aria-label="Manual quote requests"
      className="grid gap-3 md:hidden"
    >
      {requests.map((request) => (
        <li
          key={request.requestId}
          className="rounded-xl border border-border bg-background/40 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {request.organizationName}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {request.requestedByEmail ?? "Requester email unavailable"}
              </p>
            </div>
            <Badge variant="outline" className="shrink-0">
              <span className="sr-only">Request age: </span>
              {formatRequestAge(request.requestAgeSeconds)}
            </Badge>
          </div>

          <div className="mt-4 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Project / job
            </p>
            <p className="mt-2 font-medium text-foreground">
              {request.projectName ?? "No project"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {request.jobTitle}
            </p>
          </div>

          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Lifecycle
            </p>
            <RequestLifecycle request={request} />
          </div>

          <div className="mt-4">
            <RequestAction request={request} fullWidth />
          </div>
        </li>
      ))}
    </ul>
  );
}

function InboxPagination({
  cursorHistory,
  isFetching,
  nextCursor,
  setCursorHistory,
}: Readonly<{
  cursorHistory: ReadonlyArray<string | null>;
  isFetching: boolean;
  nextCursor: string | null;
  setCursorHistory: Dispatch<SetStateAction<Array<string | null>>>;
}>) {
  return (
    <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={cursorHistory.length === 1 || isFetching}
        onClick={() => {
          setCursorHistory((current) => current.slice(0, -1));
        }}
      >
        <ArrowLeft className="mr-2 h-4 w-4" />
        Previous
      </Button>
      <p className="text-xs text-muted-foreground">
        Page {cursorHistory.length}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!nextCursor || isFetching}
        onClick={() => {
          if (nextCursor) {
            setCursorHistory((current) => [...current, nextCursor]);
          }
        }}
      >
        Next
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}

function InboxContent({
  accessQuery,
  cursorHistory,
  requestsQuery,
  setCursorHistory,
}: Readonly<{
  accessQuery: UseQueryResult<ManualQuoteOperatorAccess>;
  cursorHistory: ReadonlyArray<string | null>;
  requestsQuery: UseQueryResult<AdminManualQuoteRequestPage>;
  setCursorHistory: Dispatch<SetStateAction<Array<string | null>>>;
}>) {
  if (accessQuery.isLoading) {
    return <InboxLoadingState />;
  }

  if (accessQuery.isError) {
    return <InboxAuthorizationError />;
  }

  if (!accessQuery.data?.hasCapability) {
    return <InboxUnauthorizedState />;
  }

  if (requestsQuery.isLoading) {
    return <InboxLoadingState />;
  }

  if (requestsQuery.isError) {
    const error =
      requestsQuery.error instanceof Error ? requestsQuery.error : null;

    return (
      <InboxRequestError
        error={error}
        onRetry={() => {
          void requestsQuery.refetch();
        }}
      />
    );
  }

  const requests = requestsQuery.data?.items ?? [];

  if (requests.length === 0) {
    return <InboxEmptyState />;
  }

  return (
    <>
      <InboxRequestTable requests={requests} />
      <InboxRequestCards requests={requests} />
      <InboxPagination
        cursorHistory={cursorHistory}
        isFetching={requestsQuery.isFetching}
        nextCursor={requestsQuery.data?.nextCursor ?? null}
        setCursorHistory={setCursorHistory}
      />
    </>
  );
}

export function ManualQuoteRequestInbox() {
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([
    null,
  ]);
  const cursor = cursorHistory[cursorHistory.length - 1] ?? null;
  const accessQuery = useQuery({
    queryKey: ["manual-quote-admin-access"],
    queryFn: fetchManualQuoteOperatorAccess,
  });
  const requestsQuery = useQuery({
    queryKey: ["admin-manual-quote-requests", cursor],
    queryFn: () => fetchAdminManualQuoteRequests({ cursor, limit: PAGE_SIZE }),
    enabled: accessQuery.data?.hasCapability === true,
  });

  return (
    <Card className="border-border bg-muted">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Manual quote requests</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              Oldest active customer requests appear first. Completion is bound
              to the exact request, quote run, and job.
            </p>
          </div>
          {accessQuery.data?.hasCapability ? (
            <Badge variant="outline">
              {accessQuery.data.hasAal2
                ? "AAL2 ready"
                : "MFA required to complete"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <InboxContent
          accessQuery={accessQuery}
          cursorHistory={cursorHistory}
          requestsQuery={requestsQuery}
          setCursorHistory={setCursorHistory}
        />
      </CardContent>
    </Card>
  );
}
