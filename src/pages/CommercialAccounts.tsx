import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Loader2,
  RefreshCcw,
  Search,
} from "lucide-react";
import {
  Link,
  Navigate,
  useSearchParams,
} from "react-router-dom";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { CommercialAdminShell } from "@/components/admin/commercial/CommercialAdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  searchCommercialAccounts,
  type CommercialAccountSearchItem,
} from "@/features/quotes/api/commercial-account-admin-api";
import { fetchCommercialAdminAccess } from "@/features/quotes/api/commercial-admin-access-api";
import { formatStatusLabel } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";

const PAGE_SIZE = 25;

function isSensitiveSearch(value: string): boolean {
  return value.trim().includes("@");
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "No requests yet";
}

function AccountPlan({
  account,
}: Readonly<{ account: CommercialAccountSearchItem }>) {
  return (
    <div>
      <Badge variant={account.effective.plan === "pro" ? "default" : "outline"}>
        {account.effective.plan === "pro" ? "Pro" : "Free"}
      </Badge>
      <p className="mt-2 text-xs text-muted-foreground">
        {formatStatusLabel(account.effective.source)}
      </p>
      {account.effective.validUntil ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Through {formatDateTime(account.effective.validUntil)}
        </p>
      ) : null}
    </div>
  );
}

function AccountActivity({
  account,
}: Readonly<{ account: CommercialAccountSearchItem }>) {
  return (
    <div className="space-y-1 text-sm">
      <p>{account.quoteActivity.manualRequestCount} manual</p>
      <p>{account.quoteActivity.automaticRequestCount} automatic</p>
      {account.quoteActivity.activeManualRequestCount > 0 ? (
        <p className="text-amber-600">
          {account.quoteActivity.activeManualRequestCount} waiting
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {formatDateTime(account.quoteActivity.lastRequestAt)}
      </p>
    </div>
  );
}

function AccountCards({
  accounts,
}: Readonly<{
  accounts: readonly CommercialAccountSearchItem[];
}>) {
  return (
    <div className="grid gap-3 md:hidden">
      {accounts.map((account) => (
        <Card key={account.organizationId} className="border-border bg-muted">
          <CardContent className="space-y-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{account.organizationName}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {account.organizationSlug}
                </p>
              </div>
              <AccountPlan account={account} />
            </div>
            <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-accent p-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Members
                </p>
                <p className="mt-1 font-medium">{account.memberCount}</p>
              </div>
              <AccountActivity account={account} />
            </div>
            {account.matchingMemberEmails.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Match: {account.matchingMemberEmails.join(", ")}
              </p>
            ) : null}
            <Button asChild className="w-full">
              <Link to={`/internal/commercial/${account.organizationId}`}>
                View account
              </Link>
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AccountResults({
  isLoading,
  isError,
  error,
  accounts,
  search,
  onRetry,
}: Readonly<{
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  accounts: readonly CommercialAccountSearchItem[];
  search: string;
  onRetry: () => void;
}>) {
  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-3xl border border-dashed border-border">
        <Loader2
          className="h-6 w-6 animate-spin text-primary"
          aria-label="Loading commercial accounts"
        />
      </div>
    );
  }

  if (isError) {
    return (
      <Card className="border-destructive/30 bg-destructive/10">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <p className="text-sm text-destructive" role="alert">
            {getErrorMessage(error, "Commercial accounts could not be loaded.")}
          </p>
          <Button type="button" variant="outline" onClick={onRetry}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (accounts.length === 0) {
    let emptyDescription = "Organizations appear here when they are created.";

    if (search) {
      emptyDescription = "Try a different organization or member email.";
    }

    return (
      <div className="rounded-3xl border border-dashed border-border bg-accent p-10 text-center">
        <Building2 className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-4 font-medium">No commercial accounts found</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {emptyDescription}
        </p>
      </div>
    );
  }

  return (
    <>
      <AccountCards accounts={accounts} />
      <div className="hidden overflow-x-auto rounded-3xl border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Organization</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Effective access</TableHead>
              <TableHead>Quote activity</TableHead>
              <TableHead className="text-right">Account</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.organizationId}>
                <TableCell>
                  <p className="font-medium">{account.organizationName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {account.organizationSlug}
                  </p>
                  {account.matchingMemberEmails.length > 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Match: {account.matchingMemberEmails.join(", ")}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>{account.memberCount}</TableCell>
                <TableCell>
                  <AccountPlan account={account} />
                </TableCell>
                <TableCell>
                  <AccountActivity account={account} />
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm">
                    <Link to={`/internal/commercial/${account.organizationId}`}>
                      View
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

const CommercialAccounts = () => {
  const {
    user,
    activeMembership,
    isPlatformAdmin,
    signOut,
    isAuthInitializing,
  } = useAppSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSearch = searchParams.get("q")?.trim() ?? "";
  const [search, setSearch] = useState(urlSearch);
  const [searchInput, setSearchInput] = useState(search);
  const skipNextEmptyUrlSync = useRef(false);
  const [pagination, setPagination] = useState<{
    search: string;
    cursor: string | null;
    history: Array<string | null>;
  }>({
    search,
    cursor: null,
    history: [],
  });
  const scopedPagination =
    pagination.search === search
      ? pagination
      : { search, cursor: null, history: [] };
  const { cursor, history: cursorHistory } = scopedPagination;
  const accessQuery = useQuery({
    queryKey: ["commercial-admin-access"],
    queryFn: fetchCommercialAdminAccess,
    enabled: Boolean(user),
  });
  const accountsQuery = useQuery({
    queryKey: ["commercial-accounts", search, cursor],
    queryFn: () =>
      searchCommercialAccounts({
        search: search || null,
        cursor,
        limit: PAGE_SIZE,
      }),
    enabled: accessQuery.data?.hasCapability === true,
  });

  useEffect(() => {
    if (isSensitiveSearch(urlSearch)) {
      skipNextEmptyUrlSync.current = true;
      setSearch(urlSearch);
      setSearchInput(urlSearch);
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("q");
          return next;
        },
        { replace: true },
      );
      return;
    }

    if (skipNextEmptyUrlSync.current && !urlSearch) {
      skipNextEmptyUrlSync.current = false;
      return;
    }

    skipNextEmptyUrlSync.current = false;
    setSearch(urlSearch);
    setSearchInput(urlSearch);
  }, [setSearchParams, urlSearch]);

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your commercial admin session." />;
  }

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = searchInput.trim();
    setSearch(next);

    if (isSensitiveSearch(next)) {
      if (urlSearch) {
        skipNextEmptyUrlSync.current = true;
        setSearchParams(
          (current) => {
            const scrubbed = new URLSearchParams(current);
            scrubbed.delete("q");
            return scrubbed;
          },
          { replace: true },
        );
      }
      return;
    }

    skipNextEmptyUrlSync.current = false;
    if (next === urlSearch) {
      return;
    }

    setSearchParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next) {
          updated.set("q", next);
        } else {
          updated.delete("q");
        }
        return updated;
      },
      { replace: true },
    );
  };

  const renderContent = () => {
    if (accessQuery.isLoading) {
      return (
        <div className="flex min-h-64 items-center justify-center">
          <Loader2
            className="h-6 w-6 animate-spin text-primary"
            aria-label="Checking commercial account access"
          />
        </div>
      );
    }

    if (accessQuery.isError) {
      return (
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(
                accessQuery.error,
                "Commercial account authorization could not be checked.",
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void accessQuery.refetch()}
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      );
    }

    if (!accessQuery.data?.hasCapability) {
      return (
        <Card className="border-border bg-muted">
          <CardHeader>
            <CardTitle>Not authorized</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            A server-provisioned billing-admin capability is required. An
            organization-admin role does not grant access to commercial state.
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="space-y-5">
        <form
          onSubmit={submitSearch}
          className="flex flex-col gap-3 sm:flex-row"
          role="search"
        >
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label="Search commercial accounts"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Organization, slug, or member email"
              className="pl-9"
            />
          </div>
          <Button type="submit">Search</Button>
        </form>

        <AccountResults
          isLoading={accountsQuery.isLoading}
          isError={accountsQuery.isError}
          error={accountsQuery.error}
          accounts={accountsQuery.data?.items ?? []}
          search={search}
          onRetry={() => void accountsQuery.refetch()}
        />

        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={cursorHistory.length === 0 || accountsQuery.isFetching}
            onClick={() => {
              setPagination((current) => {
                const scoped =
                  current.search === search ? current : scopedPagination;

                return {
                  search,
                  cursor: scoped.history.at(-1) ?? null,
                  history: scoped.history.slice(0, -1),
                };
              });
            }}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Previous
          </Button>
          {accountsQuery.isFetching && !accountsQuery.isLoading ? (
            <span className="text-xs text-muted-foreground">Refreshing…</span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={!accountsQuery.data?.nextCursor || accountsQuery.isFetching}
            onClick={() => {
              const nextCursor = accountsQuery.data?.nextCursor;

              if (!nextCursor) {
                return;
              }

              setPagination({
                search,
                cursor: nextCursor,
                history: [...cursorHistory, cursor],
              });
            }}
          >
            Next
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  };

  return (
    <CommercialAdminShell
      user={user}
      activeMembership={activeMembership}
      isPlatformAdmin={isPlatformAdmin}
      onSignOut={signOut}
    >
      <div className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col px-4 pb-10 pt-5 md:px-7 md:pt-7">
        <header className="mb-7">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Commercial operations
          </p>
          <h1 className="mt-2 text-3xl font-medium tracking-[-0.03em] md:text-4xl">
            Customer accounts
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Review effective Free or Pro access, quote activity, paid
            subscriptions, and audited manual grants without entering a
            customer workspace.
          </p>
        </header>
        {renderContent()}
      </div>
    </CommercialAdminShell>
  );
};

export default CommercialAccounts;
