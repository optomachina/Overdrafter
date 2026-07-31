import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import {
  Link,
  Navigate,
  useParams,
} from "react-router-dom";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { CommercialAdminShell } from "@/components/admin/commercial/CommercialAdminShell";
import { CommercialEntitlementControls } from "@/components/admin/commercial/CommercialEntitlementControls";
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
  getCommercialAccount,
  listCommercialAccountAudit,
  type CommercialAccountAuditEvent,
  type CommercialAccountDetail as CommercialAccountDetailData,
} from "@/features/quotes/api/commercial-account-admin-api";
import { fetchCommercialAdminAccess } from "@/features/quotes/api/commercial-admin-access-api";
import { formatStatusLabel } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";

const AUDIT_PAGE_SIZE = 25;

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not set";
}

function LoadingPanel({ label }: Readonly<{ label: string }>) {
  return (
    <div className="flex min-h-64 items-center justify-center rounded-3xl border border-dashed border-border">
      <Loader2
        className="h-6 w-6 animate-spin text-primary"
        aria-label={label}
      />
    </div>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: Readonly<{
  message: string;
  onRetry: () => void;
}>) {
  return (
    <Card className="border-destructive/30 bg-destructive/10">
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
        <p className="text-sm text-destructive" role="alert">
          {message}
        </p>
        <Button type="button" variant="outline" onClick={onRetry}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

function AccessSummary({
  account,
}: Readonly<{ account: CommercialAccountDetailData }>) {
  const { effective } = account;
  let sourceDescription = formatStatusLabel(effective.source);

  if (effective.source === "default") {
    sourceDescription = "Free account — no paid subscription or active manual grant";
  } else if (effective.source.startsWith("subscription")) {
    sourceDescription = `Paid subscription — ${formatStatusLabel(effective.source)}`;
  } else if (effective.source === "manual_trial") {
    sourceDescription = "Manual trial grant";
  } else if (effective.source === "manual_complimentary") {
    sourceDescription = "Manual complimentary grant";
  }

  return (
    <Card className="border-border bg-muted">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Effective access
            </p>
            <CardTitle className="mt-2 text-3xl">
              {effective.plan === "pro" ? "Pro" : "Free"}
            </CardTitle>
          </div>
          <Badge variant={effective.plan === "pro" ? "default" : "outline"}>
            {effective.automaticQuoteCollection
              ? "Automatic quotes on"
              : "Manual quotes"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-border bg-accent p-4 sm:col-span-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Source
          </p>
          <p className="mt-2 font-medium">{sourceDescription}</p>
        </div>
        <div className="rounded-2xl border border-border bg-accent p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Valid through
          </p>
          <p className="mt-2 font-medium">
            {formatDateTime(effective.validUntil)}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-accent p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Review
          </p>
          <p className="mt-2 font-medium">
            {effective.reviewDue
              ? "Review due now"
              : formatDateTime(effective.reviewAt)}
          </p>
        </div>
        {effective.graceEndsAt ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 sm:col-span-2 xl:col-span-4">
            <p className="font-medium text-amber-700">Past-due grace period</p>
            <p className="mt-1 text-sm text-amber-700/80">
              Pro remains active until {formatDateTime(effective.graceEndsAt)}.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SubscriptionHistory({
  account,
}: Readonly<{
  account: CommercialAccountDetailData;
}>) {
  return (
    <Card className="border-border bg-muted">
      <CardHeader>
        <CardTitle>Paid subscriptions</CardTitle>
        <p className="text-sm text-muted-foreground">
          Stripe-backed subscriptions are shown separately from trial and
          complimentary access.
        </p>
      </CardHeader>
      <CardContent>
        {account.subscriptions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No paid subscription history is recorded.
          </div>
        ) : (
          <div className="space-y-3">
            {account.subscriptions.map((subscription) => (
              <div
                key={subscription.id}
                className="grid gap-3 rounded-2xl border border-border bg-accent p-4 sm:grid-cols-2 xl:grid-cols-4"
              >
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Status
                  </p>
                  <Badge className="mt-2" variant="outline">
                    {formatStatusLabel(subscription.status)}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Billing
                  </p>
                  <p className="mt-2 text-sm font-medium">
                    {subscription.billingInterval
                      ? formatStatusLabel(subscription.billingInterval)
                      : "Unknown interval"}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Paid through
                  </p>
                  <p className="mt-2 text-sm font-medium">
                    {formatDateTime(subscription.currentPeriodEnd)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Cancellation
                  </p>
                  <p className="mt-2 text-sm font-medium">
                    {subscription.cancelAtPeriodEnd
                      ? "Cancels at period end"
                      : "No scheduled cancellation"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MembersAndActivity({
  account,
}: Readonly<{
  account: CommercialAccountDetailData;
}>) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card className="border-border bg-muted">
        <CardHeader>
          <CardTitle>Organization members</CardTitle>
        </CardHeader>
        <CardContent>
          {account.members.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No organization members are recorded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {account.members.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell>
                        {member.email ?? "Email unavailable"}
                      </TableCell>
                      <TableCell>{formatStatusLabel(member.role)}</TableCell>
                      <TableCell>{formatDateTime(member.joinedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border bg-muted">
        <CardHeader>
          <CardTitle>Quote activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ["Manual", account.quoteActivity.manualRequestCount],
              ["Automatic", account.quoteActivity.automaticRequestCount],
              ["Waiting", account.quoteActivity.activeManualRequestCount],
              ["Received", account.quoteActivity.receivedRequestCount],
              ["Failed", account.quoteActivity.failedRequestCount],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-2xl border border-border bg-accent p-3"
              >
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl font-medium">{value}</p>
              </div>
            ))}
          </div>
          {account.quoteActivity.recentRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No quote requests have been recorded.
            </p>
          ) : (
            <div className="space-y-2">
              {account.quoteActivity.recentRequests.map((request) => (
                <div
                  key={request.requestId}
                  className="rounded-2xl border border-border bg-accent p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{request.jobTitle}</p>
                    <Badge variant="outline">
                      {formatStatusLabel(request.requestMode)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatStatusLabel(request.status)} ·{" "}
                    {formatDateTime(request.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AuditEvent({
  event,
}: Readonly<{ event: CommercialAccountAuditEvent }>) {
  return (
    <div className="rounded-2xl border border-border bg-accent p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{formatStatusLabel(event.action)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {event.actorEmail ?? event.actorUserId}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatDateTime(event.createdAt)}
        </p>
      </div>
      <p className="mt-3 text-sm">{event.reason}</p>
      <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
        {event.idempotencyKey}
      </p>
    </div>
  );
}

function AuditResults({
  isLoading,
  isError,
  error,
  events,
  onRetry,
}: Readonly<{
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  events: readonly CommercialAccountAuditEvent[];
  onRetry: () => void;
}>) {
  if (isLoading) {
    return <LoadingPanel label="Loading commercial audit" />;
  }

  if (isError) {
    return (
      <ErrorPanel
        message={getErrorMessage(
          error,
          "Commercial audit history could not be loaded.",
        )}
        onRetry={onRetry}
      />
    );
  }

  if (events.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No commercial audit events are recorded.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {events.map((event) => (
        <AuditEvent key={event.eventId} event={event} />
      ))}
    </div>
  );
}

const CommercialAccountDetail = () => {
  const { organizationId } = useParams<{ organizationId: string }>();
  const queryClient = useQueryClient();
  const {
    user,
    activeMembership,
    isPlatformAdmin,
    signOut,
    isAuthInitializing,
  } = useAppSession();
  const [auditPagination, setAuditPagination] = useState<{
    organizationId: string | undefined;
    cursor: string | null;
    history: Array<string | null>;
  }>({
    organizationId,
    cursor: null,
    history: [],
  });
  const scopedAuditPagination =
    auditPagination.organizationId === organizationId
      ? auditPagination
      : { organizationId, cursor: null, history: [] };
  const {
    cursor: auditCursor,
    history: auditHistory,
  } = scopedAuditPagination;
  const accessQuery = useQuery({
    queryKey: ["commercial-admin-access"],
    queryFn: fetchCommercialAdminAccess,
    enabled: Boolean(user),
  });
  const accountQuery = useQuery({
    queryKey: ["commercial-account", organizationId],
    queryFn: () => getCommercialAccount(organizationId ?? ""),
    enabled:
      Boolean(organizationId)
      && accessQuery.data?.hasCapability === true,
  });
  const auditQuery = useQuery({
    queryKey: ["commercial-account-audit", organizationId, auditCursor],
    queryFn: () =>
      listCommercialAccountAudit({
        organizationId: organizationId ?? "",
        cursor: auditCursor,
        limit: AUDIT_PAGE_SIZE,
      }),
    enabled:
      Boolean(organizationId)
      && accessQuery.data?.hasCapability === true,
  });

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your commercial admin session." />;
  }

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  if (!organizationId) {
    return <Navigate to="/internal/commercial" replace />;
  }

  const refreshCommercialState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["commercial-account", organizationId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["commercial-account-audit", organizationId],
      }),
      queryClient.invalidateQueries({ queryKey: ["commercial-accounts"] }),
    ]);
  };

  const renderContent = () => {
    if (accessQuery.isLoading) {
      return <LoadingPanel label="Checking commercial account access" />;
    }

    if (accessQuery.isError) {
      return (
        <ErrorPanel
          message={getErrorMessage(
            accessQuery.error,
            "Commercial account authorization could not be checked.",
          )}
          onRetry={() => void accessQuery.refetch()}
        />
      );
    }

    if (!accessQuery.data?.hasCapability) {
      return (
        <Card className="border-border bg-muted">
          <CardHeader>
            <CardTitle>Not authorized</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            A server-provisioned billing-admin capability is required. Customer
            organization roles cannot read or change this commercial account.
          </CardContent>
        </Card>
      );
    }

    if (accountQuery.isLoading) {
      return <LoadingPanel label="Loading commercial account" />;
    }

    if (accountQuery.isError || !accountQuery.data) {
      return (
        <ErrorPanel
          message={getErrorMessage(
            accountQuery.error,
            "The exact commercial account could not be loaded.",
          )}
          onRetry={() => void accountQuery.refetch()}
        />
      );
    }

    const account = accountQuery.data;

    return (
      <div className="space-y-5">
        {accountQuery.isFetching ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            Refreshing account truth…
          </p>
        ) : null}
        <AccessSummary account={account} />
        <CommercialEntitlementControls
          key={organizationId}
          organizationId={organizationId}
          grants={account.grants}
          hasAal2={accessQuery.data.hasAal2}
          onAccessRefresh={async () => {
            await accessQuery.refetch();
          }}
          onChanged={refreshCommercialState}
        />
        <SubscriptionHistory account={account} />
        <MembersAndActivity account={account} />

        <Card className="border-border bg-muted">
          <CardHeader>
            <CardTitle>Commercial audit</CardTitle>
            <p className="text-sm text-muted-foreground">
              Append-only billing actions for this exact organization.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <AuditResults
              isLoading={auditQuery.isLoading}
              isError={auditQuery.isError}
              error={auditQuery.error}
              events={auditQuery.data?.items ?? []}
              onRetry={() => void auditQuery.refetch()}
            />

            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={auditHistory.length === 0 || auditQuery.isFetching}
                onClick={() => {
                  setAuditPagination((current) => {
                    const scoped =
                      current.organizationId === organizationId
                        ? current
                        : scopedAuditPagination;

                    return {
                      organizationId,
                      cursor: scoped.history.at(-1) ?? null,
                      history: scoped.history.slice(0, -1),
                    };
                  });
                }}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!auditQuery.data?.nextCursor || auditQuery.isFetching}
                onClick={() => {
                  const nextCursor = auditQuery.data?.nextCursor;

                  if (!nextCursor) {
                    return;
                  }

                  setAuditPagination({
                    organizationId,
                    cursor: nextCursor,
                    history: [...auditHistory, auditCursor],
                  });
                }}
              >
                Next
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  };

  const accountName =
    accountQuery.data?.organization.name ?? "Commercial account";

  return (
    <CommercialAdminShell
      user={user}
      activeMembership={activeMembership}
      isPlatformAdmin={isPlatformAdmin}
      onSignOut={signOut}
    >
      <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col px-4 pb-10 pt-5 md:px-7 md:pt-7">
        <header className="mb-7">
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link to="/internal/commercial">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Customer accounts
            </Link>
          </Button>
          <p className="mt-5 text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Commercial account
          </p>
          <h1 className="mt-2 text-3xl font-medium tracking-[-0.03em] md:text-4xl">
            {accountName}
          </h1>
          {accountQuery.data ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {accountQuery.data.organization.slug} ·{" "}
              {accountQuery.data.members.length} members
            </p>
          ) : null}
        </header>
        {renderContent()}
      </div>
    </CommercialAdminShell>
  );
};

export default CommercialAccountDetail;
