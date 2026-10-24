# OVD-1032 round 4 contrast self-check

Base: `99bd383a`; starting head: `de1b4475`. Local working-tree repair, no git writes.

Method: PostCSS/Tailwind compilation of `src/index.css` with `tailwind.config.ts`; resolve actual emitted declarations and theme variables, convert OKLCH to sRGB, composite alpha in sRGB, calculate WCAG relative luminance. Base/hover/focus states are checked. No Playwright was run.

All added text/background utilities compile, including pseudo-element and dark/group variants. Transparent elements inherit the listed parent surfaces. Foreground fills use the same ratios as foreground text. Skeleton measurements include the minimum pulse opacity (0.5).

## Findings and fixes

- 12 organization Inputs inherit the Input default muted placeholder, distinct from value ink. Light 4.350:1 is the explicitly permitted OVD-1040 exception; dark 5.829:1. No placeholder/value equality remains.
- Shared error tone uses bg-card + text-destructive + dark:text-red-300. Account notification/billing/sourcing/org-save, vendor preference, both Stripe errors, and the PR-modified internal queue last-error message use it.
- Ready/Warning/Blocked tiles and active/attention ActivityLog entries use bg-card with their muted descendants.
- Guard rejects new inline destructive classes without a dark error hue. Exact pre-PR source lines are grandfathered in legacy-destructive-classes.json so unrelated main failures are untouched. Three required error consumers must contain no inline text-destructive at all.
- Two skeleton bars use bg-muted-foreground against bg-accent, passing 1.5:1 at both pulse extrema.
- Full audit additionally repaired the recommended score, payment confirmation and internal diagnostics parent surfaces; destructive toast close dark color; fastest-quote badge uses the same compiled neutral surface as the other badges.

## Measured pairs

Repeated sites/states share these measurements. Foreground parent surfaces include conservative inherited-surface coverage. Received/failed/canceled request tones are unchanged controls.

| Pair / state | Light | Dark |
|---|---:|---:|
| `destructive-toast-close/base` | 4.509 | 5.299 |
| `org-placeholder (OVD-1040)` | 4.350 | 5.829 |
| `skeleton opacity 0.5` | 1.911 | 2.531 |
| `skeleton opacity 1` | 4.350 | 5.829 |
| `text/base on var(--card)` | 16.357 | 18.958 |
| `text/base on var(--background)` | 14.987 | 18.958 |
| `text/base on var(--accent)` | 13.122 | 14.477 |
| `surface/base on var(--accent)` | 13.122 | 14.477 |
| `badge/base on var(--accent)` | 13.122 | 14.477 |
| `state/base on var(--accent)` | 13.122 | 14.477 |
| `callout/base on var(--accent)` | 13.122 | 14.477 |
| `error/base on var(--card)` | 4.922 | 10.429 |
| `action/base on var(--card)` | 16.357 | 18.958 |
| `action/base on var(--background)` | 14.987 | 18.958 |
| `action/base on var(--accent)` | 13.122 | 14.477 |
| `stat-label/base on var(--ws-surface-inset)` | 13.122 | 19.442 |
| `request-not_requested/base on var(--accent)` | 13.122 | 14.477 |
| `request-queued/base on var(--accent)` | 13.122 | 14.477 |
| `request-requesting/base on var(--accent)` | 13.122 | 14.477 |
| `request-received/base on rgb(4 120 87 / 1)` | 5.484 | 5.484 |
| `request-failed/base on rgb(190 18 60 / 1)` | 6.285 | 6.285 |
| `request-canceled/base on rgb(190 18 60 / 1)` | 6.285 | 6.285 |
| `assignee-0/base on var(--card)` | 7.188 | 18.958 |
| `assignee-1/base on var(--card)` | 7.303 | 18.958 |
| `assignee-2/base on var(--card)` | 6.738 | 18.958 |
| `assignee-3/base on var(--card)` | 7.618 | 18.958 |
| `assignee-4/base on var(--card)` | 6.906 | 18.958 |
| `assignee-5/base on var(--card)` | 7.829 | 18.958 |
| `review-Ready/base on var(--card)` | 5.423 | 7.633 |
| `review-Warning/base on var(--card)` | 5.423 | 7.633 |
| `review-Blocked/base on var(--card)` | 5.423 | 7.633 |
| `activity-active-timestamp/base on var(--card)` | 5.423 | 7.633 |
| `activity-active-detail/base on var(--card)` | 5.423 | 7.633 |
| `activity-attention-timestamp/base on var(--card)` | 5.423 | 7.633 |
| `activity-attention-detail/base on var(--card)` | 5.423 | 7.633 |
| `payment-confirmed/base on var(--card)` | 5.423 | 7.633 |
| `recommended-score/base on var(--card)` | 5.423 | 7.633 |
| `internal-diagnostics/base on var(--card)` | 5.423 | 7.633 |
| `foreground/background/base on var(--background)` | 14.987 | 18.958 |
| `foreground/card/base on var(--card)` | 16.357 | 18.958 |
| `foreground/muted/base on var(--muted)` | 13.122 | 14.477 |
| `foreground/accent/base on var(--accent)` | 13.122 | 14.477 |
| `foreground/ws-base/base on var(--ws-surface-base)` | 14.987 | 18.455 |
| `foreground/ws-card/base on var(--ws-surface-card)` | 16.357 | 17.853 |
| `foreground/ws-inset/base on var(--ws-surface-inset)` | 13.122 | 19.442 |
| `foreground/ws-raised/base on var(--ws-surface-raised)` | 16.357 | 16.970 |
| `foreground/ws-shell/base on var(--ws-surface-shell)` | 16.357 | 17.171 |
| `foreground/ws-deep/base on var(--ws-surface-deep)` | 13.122 | 18.359 |
| `foreground/ws-overlay/base on var(--ws-surface-overlay)` | 14.987 | 15.422 |
| `muted-foreground on background` | 4.969 | 7.633 |
| `muted-foreground on card` | 5.423 | 7.633 |
| `muted-foreground on accent` | 4.350 | 5.829 |

## Remaining exceptions

Only the explicitly permitted 12 muted org placeholders are newly changed text below 4.5:1 (4.350 light). Skeletons are non-text, with a 1.5:1 requirement. Pre-existing muted-on-inset text remains outside scope: ActivityLog default entries, tradeoff comparison/alternatives, workspace reason/metadata rows, procurement option descriptions/summary labels, selected QuoteList details, and internal queue payload/metadata. The unchanged legacy destructive lines are recorded in the test fixture, not repaired.

## Complete changed class-site inventory (`git diff 99bd383a`)

Each entry is an added line with text/background utilities or STATUS_TONE usage; the measured pair table above resolves shared tones and inherited parent backgrounds. Non-color typography utilities are retained for traceability.


### src/components/CadModelThumbnail.tsx

- L229: `"absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted text-center text-foreground",`
- L245: `<div className="rounded-full border border-border bg-accent p-3 text-foreground">`

### src/components/chat/WorkspaceAccountMenu.tsx

- L141: `"workspace-shell w-[min(100vw,30rem)] border-l border-border bg-ws-raised p-0 text-foreground sm:max-w-[30rem] [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-full [&>button]:bg-accent [&>button]:p-2 [&>button]:text-foreground [&>button]:hover:bg-accent [&>button]:hover:text-foreground";`
- L143: `"workspace-shell w-[min(100vw,30rem)] border-l border-border bg-ws-raised p-0 text-foreground shadow-none sm:max-w-[30rem] [&>button]:right-5 [&>button]:top-5 [&>button]:rounded-[2px] [&>button]:bg-accent [&>button]:p-2 [&>button]:text-foreground [&>button]:hover:bg-accent [&>button]:hover:text-foreground";`
- L146: `'shrink-0 px-2.5 py-1 text-[11px] font-medium ${STATUS_TONE.state}';`
- L309: `return <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-foreground">{children}</p>;`
- L341: `<p className="mt-1 text-sm leading-5 text-foreground">{description}</p>`
- L354: `className="rounded border border-border bg-accent px-2.5 py-1 text-xs font-medium text-foreground"`
- L421: `return <p className="text-sm leading-6 text-foreground">Loading notifications...</p>;`
- L426: `<p role="alert" className={'text-sm leading-6 ${STATUS_TONE.error}'}>`
- L434: `<p className="text-sm leading-6 text-foreground">`
- L442: `<p className="text-sm leading-6 text-foreground">`
- L454: `STATUS_TONE.surface,`
- L460: `<span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", STATUS_TONE.state)}>`
- L464: `<span className="text-xs text-foreground">{formatNotificationTimestamp(item.occurredAt)}</span>`
- L467: `<p className="mt-2 text-sm leading-6 text-foreground">{item.detail}</p>`
- L472: `className="h-8 rounded-full border border-border px-3 text-xs text-foreground hover:bg-accent hover:text-foreground"`
- L911: `<p className="mt-2 text-sm leading-6 text-foreground">`
- L927: `<p className="mt-2 text-sm leading-6 text-foreground">`
- L975: `<p className="mt-1 text-sm leading-6 text-foreground">{definition.description}</p>`
- L999: `<span className="mt-1 block text-xs leading-5 text-foreground">{channelDescription}</span>`
- L1027: `className="h-8 rounded-full border border-border px-3 text-xs text-foreground hover:bg-accent hover:text-foreground"`
- L1054: `<p className="truncate text-sm text-foreground">{user.email ?? "No email available"}</p>`
- L1073: `<span className="rounded-full border border-border bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground">`
- L1080: `<p className="mt-1 text-sm leading-6 text-foreground">`
- L1085: `className={'mt-3 block px-3 py-2 text-sm leading-5 ${STATUS_TONE.callout}'}`
- L1116: `<p className="mt-3 text-xs leading-5 text-foreground">`
- L1121: `<p className={'mt-3 text-sm leading-5 ${STATUS_TONE.error}'} role="alert">`
- L1142: `className="text-xs text-foreground hover:text-foreground transition-colors"`
- L1167: `className="text-xs text-foreground hover:text-foreground transition-colors"`
- L1195: `className="text-xs text-foreground hover:text-foreground transition-colors"`
- L1246: `{sourcingError && <p role="alert" className={'mt-2 text-xs ${STATUS_TONE.error}'}>{sourcingError}</p>}`
- L1283: `<p className="text-sm leading-6 text-foreground">`
- L1304: `<p className="text-sm leading-6 text-foreground">Loading archived items...</p>`
- L1308: `<p className="text-sm leading-6 text-foreground">No archived items yet.</p>`
- L1317: `<p className="mt-1 text-sm text-foreground">`
- L1330: `<Folder className="h-[18px] w-[18px] text-foreground" strokeWidth={1.9} />`
- L1334: `<p className="mt-1 text-sm text-foreground">{formatArchivedAt(item.project.project.archived_at)}</p>`
- L1337: `<span className="rounded-full border border-border bg-accent px-3 py-1 text-xs font-medium text-foreground">`
- L1359: `<Box className="h-[18px] w-[18px] text-foreground" strokeWidth={1.9} />`
- L1363: `<p className="mt-1 text-sm text-foreground">{formatArchivedAt(item.job.job.archived_at)}</p>`
- L1365: `<p className="mt-3 truncate text-sm text-foreground">{item.job.projectNames.join(" · ")}</p>`
- L1380: `className="h-9 rounded-full border border-border bg-accent px-3 text-foreground hover:bg-accent hover:text-foreground"`
- L1400: `className="h-9 rounded-full border border-border bg-accent px-3 text-foreground hover:bg-accent hover:text-foreground"`
- L1429: `<ul className="mt-4 space-y-2 text-sm leading-6 text-foreground">`
- L1443: `<p className="mt-4 text-sm leading-6 text-foreground">`
- L1450: `<p className="mt-2 text-sm leading-6 text-foreground">`
- L1458: `<p className="mt-2 text-sm leading-6 text-foreground">`
- L1466: `<p className="mt-2 text-sm leading-6 text-foreground">`
- L1489: `<p className="mt-1 text-sm text-foreground">Use the current browser workspace today.</p>`
- L1491: `<span className={'px-3 py-1 text-xs font-medium ${STATUS_TONE.state}'}>`
- L1498: `<p className="mt-1 text-sm text-foreground">Placeholder for macOS and Windows installers.</p>`
- L1502: `<p className="mt-1 text-sm text-foreground">Placeholder for iPhone, iPad, and Android builds.</p>`
- L1513: `<p className="mt-4 text-sm leading-6 text-foreground">{shortcut.description}</p>`
- L1594: `<p className="truncate text-[13px] leading-5 text-foreground">`
- L1601: `'hidden h-5 w-5 shrink-0 items-center justify-center text-[11px] font-medium ${STATUS_TONE.state}',`
- L1613: `"pointer-events-none hidden h-8 w-8 items-center justify-center bg-accent text-foreground transition",`
- L1759: `<SheetDescription className="max-w-[28rem] pr-12 text-sm leading-6 text-foreground">`
- L1791: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1801: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1816: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1827: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1837: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1847: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1858: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1875: `: "text-foreground hover:bg-accent hover:text-foreground",`
- L1896: `: "text-foreground hover:bg-accent hover:text-foreground",`
- L1912: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1923: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1933: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1943: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1954: `className="border-border bg-accent text-foreground focus-visible:ring-white/20"`
- L1962: `{orgSaveError && <p className={'mt-3 text-xs ${STATUS_TONE.error}'}>{orgSaveError}</p>}`
- L1970: `className="flex-1 border border-border text-foreground hover:bg-accent hover:text-foreground"`
- L2004: `className="h-10 rounded-full border border-border bg-transparent px-4 text-foreground hover:bg-accent hover:text-foreground"`
- L2016: `className="h-10 rounded-full border border-border bg-accent px-4 text-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"`

### src/components/chat/WorkspaceSidebar.tsx

- L295: `className="flex items-center gap-1 rounded-[10px] py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-foreground transition-colors hover:text-foreground"`
- L316: `className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm text-foreground focus:bg-accent focus:text-foreground"`
- L324: `{selected ? <Check className="ml-auto h-4 w-4 text-foreground" /> : null}`
- L1211: `className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-foreground"`

### src/components/quotes/ActivityLog.tsx

- L23: `return "border-border bg-card text-foreground";`
- L25: `return "border-border bg-card text-foreground";`
- L28: `return "border-border bg-muted text-foreground";`
- L84: `<div className="rounded-full border border-border bg-accent p-2 text-foreground">`

### src/components/quotes/ClientQuoteDecisionPanel.tsx

- L112: `return { icon: Loader2, label: "Fetching...", color: "text-foreground", bg: "bg-accent", animate: true };`
- L117: `return { icon: XCircle, label: "Failed", color: "text-foreground", bg: "bg-accent" };`
- L119: `return { icon: AlertCircle, label: "Review", color: "text-foreground", bg: "bg-accent" };`
- L121: `return { icon: AlertCircle, label: "Follow-up", color: "text-foreground", bg: "bg-accent" };`
- L169: `<p className="mt-3 text-sm font-medium text-foreground">{title}</p>`
- L529: `<TableCell className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-foreground">`
- L548: `<TableCell className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-foreground">`
- L729: `<span className="text-sm font-medium text-foreground">`

### src/components/quotes/ClientTradeoffSummary.tsx

- L19: `<Star className={'h-4 w-4 ${STATUS_TONE.text}'} />`
- L20: `<h3 className="text-sm font-semibold text-foreground">Routing Recommendation</h3>`
- L25: `<div className="rounded-lg border border-border bg-card p-3 text-foreground">`
- L29: `className={STATUS_TONE.badge}`
- L33: `<span className="text-sm font-medium text-foreground">{summary.topPick.vendorName}</span>`
- L38: `<p className="text-xs text-foreground">{summary.topPick.statement}</p>`
- L44: `className={'px-2 py-0.5 text-[10px] ${STATUS_TONE.badge}'}`
- L56: `className={'px-2 py-0.5 text-[10px] ${STATUS_TONE.badge}'}`
- L69: `className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"`
- L97: `<span className="text-sm font-medium text-foreground">{statement.vendorName}</span>`
- L108: `className={'px-2 py-0.5 text-[10px] ${STATUS_TONE.badge}'}`

### src/components/quotes/ClientWorkspacePanelContent.tsx

- L90: `? "border-border bg-accent"`
- L92: `? "border-border bg-accent"`
- L93: `: "border-border bg-accent",`
- L107: `<div className="h-3 w-3/4 animate-pulse rounded-full bg-muted-foreground" />`
- L108: `<div className="h-3 w-1/2 animate-pulse rounded-full bg-muted-foreground" />`
- L111: `<p role="alert" className="text-sm text-foreground">{detail}</p>`
- L113: `<p className="text-sm text-foreground">{detail}</p>`
- L133: `<Badge key={reason} className="border border-border bg-muted text-foreground">`
- L258: `<Badge className="border border-border bg-accent text-foreground">{option.vendorLabel}</Badge>`
- L259: `<Badge className="border border-border bg-accent text-foreground">Qty {option.requestedQuantity}</Badge>`
- L261: `<p className="mt-3 text-sm text-foreground">{note}</p>`
- L310: `<div key={prompt} className="rounded-2xl border border-border bg-ws-base px-4 py-3 text-sm text-foreground">`

### src/components/quotes/ClientWorkspaceStateSummary.tsx

- L22: `STATUS_TONE.state,`
- L55: `<div className={cn("rounded-surface-lg border p-4", STATUS_TONE.surface, className)}>`
- L60: `<p className="mt-2 text-sm text-foreground">{state.selection.detail}</p>`

### src/components/quotes/ProcurementHandoffPanel.tsx

- L50: `STATUS_TONE.badge,`
- L74: `: "border-border bg-muted text-foreground hover:bg-accent",`
- L79: `<p className={cn("mt-2 text-sm", isSelected ? "text-foreground" : "text-muted-foreground")}>`
- L103: `: "border-border bg-muted text-foreground hover:bg-accent",`
- L108: `<p className={cn("mt-2 text-sm", isSelected ? "text-foreground" : "text-muted-foreground")}>`
- L119: `<span className="text-sm text-foreground">Ship-to contact</span>`
- L128: `<span className="text-sm text-foreground">Ship-to location</span>`
- L137: `<span className="text-sm text-foreground">Billing contact name</span>`
- L146: `<span className="text-sm text-foreground">Billing contact email</span>`
- L159: `<span className="text-sm text-foreground">PO reference</span>`
- L168: `<span className="text-sm text-foreground">Special instructions</span>`
- L189: `<div className="mt-5 space-y-3 text-sm text-foreground">`
- L199: `<div className={'mt-5 rounded-2xl border px-4 py-4 ${STATUS_TONE.surface}'}>`
- L200: `<p className={'text-[10px] uppercase tracking-[0.18em] ${STATUS_TONE.text}'}>Still needed</p>`
- L201: `<ul className={'mt-3 space-y-2 text-sm ${STATUS_TONE.text}'}>`
- L208: `<div className={'mt-5 px-4 py-4 text-sm ${STATUS_TONE.callout}'}>`
- L222: `<p className="mt-2 text-sm text-foreground">{value}</p>`

### src/components/quotes/RequestSummaryBadges.tsx

- L46: `className={STATUS_TONE.badge}`
- L52: `<Badge className={STATUS_TONE.badge}>`
- L57: `<Badge className={STATUS_TONE.badge}>`
- L62: `<Badge className={STATUS_TONE.badge}>`

### src/components/quotes/StripePaymentPanel.tsx

- L80: `<section className="rounded-[26px] border border-border bg-card p-6">`
- L82: `<CheckCircle2 className="h-6 w-6 shrink-0 text-foreground" />`
- L113: `<div className={'mb-4 rounded-2xl border border-border px-4 py-3 text-sm ${STATUS_TONE.error}'}>`
- L210: `<div className={'rounded-2xl border border-border px-4 py-3 text-sm ${STATUS_TONE.error}'}>`

### src/components/quotes/status-tone.ts

- L2: `export const STATUS_TONE = {`
- L3: `text: "text-foreground",`
- L4: `surface: "border-border bg-accent text-foreground",`
- L5: `badge: "rounded-[2px] border border-border bg-accent font-sans text-foreground hover:bg-accent",`
- L6: `state: "rounded-[2px] border border-border bg-accent font-mono text-foreground hover:bg-accent",`
- L7: `callout: "rounded-[2px] border border-border bg-accent font-sans text-foreground",`
- L8: `error: "bg-card font-sans text-destructive dark:text-red-300",`
- L9: `action: "text-foreground focus:bg-accent focus:text-foreground",`

### src/components/ui/toast.tsx

- L70: `"absolute right-2 top-2 rounded-md p-1 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-[.destructive]:text-destructive-foreground hover:text-foreground group-[.destructive]:hover:text-destructive-foreground dark:group-[.destructive]:text-red-300 dark:group-[.destructive]:hover:text-red-300 focus:opacity-100 focus:outline-none focus:ring-2 group-[.destructive]:focus:ring-red-400 group-[.destructive]:focus:ring-offset-red-600",`

### src/components/workspace/QuoteList.tsx

- L174: `<span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-foreground">`
- L179: `<span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-foreground">`
- L206: `<span className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-foreground">`

### src/components/workspace/quote-stat-bar.ts

- L37: `valueClassName: "text-foreground",`
- L43: `valueClassName: "text-foreground",`

### src/features/quotes/project-assignee.ts

- L11: `"border-border bg-card text-sky-800 dark:text-foreground",`
- L12: `"border-border bg-card text-emerald-800 dark:text-foreground",`
- L13: `"border-border bg-card text-amber-800 dark:text-foreground",`
- L14: `"border-border bg-card text-rose-800 dark:text-foreground",`
- L15: `"border-border bg-card text-cyan-800 dark:text-foreground",`
- L16: `"border-border bg-card text-fuchsia-800 dark:text-foreground",`

### src/features/quotes/quote-request-status-badge.ts

- L5: `not_requested: "border border-border bg-accent text-foreground",`
- L6: `queued: "border border-border bg-accent text-foreground hover:bg-accent",`
- L7: `requesting: "border border-border bg-accent text-foreground hover:bg-accent",`

### src/pages/ClientPackage.tsx

- L287: `<p className="text-[10px] uppercase tracking-widest text-foreground">Published</p>`
- L293: `<p className="text-[10px] uppercase tracking-widest text-foreground">Options</p>`
- L294: `<p className="mt-1 text-xl font-bold tracking-tight text-foreground">`
- L299: `<p className="text-[10px] uppercase tracking-widest text-foreground">Best Price</p>`
- L300: `<p className={'mt-1 text-xl font-bold tracking-tight ${STATUS_TONE.text}'}>`
- L307: `<p className="text-[10px] uppercase tracking-widest text-foreground">Status</p>`
- L310: `<div className={'inline-flex items-center gap-1.5 text-sm font-semibold ${STATUS_TONE.text}'}>`
- L315: `<p className={'text-sm font-semibold ${STATUS_TONE.text}'}>Awaiting selection</p>`
- L361: `<Badge className="border border-border bg-accent text-foreground">`
- L364: `<Badge className="border border-border bg-accent text-foreground">`
- L428: `<CardTitle className={STATUS_TONE.text}>Selection received</CardTitle>`
- L430: `<CardContent className={'space-y-2 text-sm ${STATUS_TONE.text}'}>`

### src/pages/ClientPart.tsx

- L108: `<p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">{comment.body}</p>`
- L736: `className="rounded-full border border-border bg-muted px-3 py-1 text-foreground transition hover:bg-accent hover:text-foreground"`
- L909: `className={STATUS_TONE.action}`
- L1081: `<label htmlFor="activity-comment" className="text-sm font-medium text-foreground">`

### src/pages/ClientPartReview.tsx

- L158: `<Badge className="border border-border bg-accent text-foreground">`
- L161: `<Badge className="border border-border bg-accent text-foreground">`
- L195: `<p className="mt-2 text-sm text-foreground">`
- L215: `<p className="mt-3 text-sm text-foreground">`
- L219: `<p className={'mt-4 text-sm ${STATUS_TONE.text}'}>`
- L223: `<p className={'mt-4 text-sm ${STATUS_TONE.text}'}>`

### src/pages/ClientProject.tsx

- L111: `className: STATUS_TONE.state,`
- L119: `className: STATUS_TONE.state,`
- L125: `className: STATUS_TONE.state,`
- L250: `className: STATUS_TONE.state,`
- L254: `className: STATUS_TONE.state,`
- L260: `className: STATUS_TONE.state,`
- L264: `className: STATUS_TONE.state,`
- L346: `className="h-full rounded-full bg-foreground"`
- L366: `<div className="mt-4 space-y-3 text-sm text-foreground">`
- L504: `return 'h-7 px-2.5 text-[11px] ${STATUS_TONE.badge}';`
- L508: `return 'h-7 px-2.5 text-[11px] ${STATUS_TONE.badge}';`
- L606: `return <p className={'text-xs ${STATUS_TONE.error}'}>{errorMessage}</p>;`
- L740: `className="h-8 rounded-full px-3 text-foreground hover:bg-accent hover:text-foreground"`
- L1377: `<Badge className="border border-border bg-accent text-foreground">Parts: {projectPartCount}</Badge>`
- L1483: `<Badge className="border border-border bg-accent text-foreground">`
- L1588: `<p className="truncate text-[13px] text-foreground">{description}</p>`
- L1594: `? STATUS_TONE.badge`
- L1605: `? STATUS_TONE.badge`

### src/pages/ClientProjectReview.tsx

- L209: `<div className="rounded-[22px] border border-border bg-card px-4 py-4 text-foreground">`
- L213: `<div className="rounded-[22px] border border-border bg-card px-4 py-4 text-foreground">`
- L217: `<div className="rounded-[22px] border border-border bg-card px-4 py-4 text-foreground">`
- L257: `<Badge className="border border-border bg-accent text-foreground">`
- L293: `<p className="mt-3 text-sm text-foreground">`
- L297: `<p className={'mt-4 text-sm ${STATUS_TONE.text}'}>`
- L301: `<p className={'mt-4 text-sm ${STATUS_TONE.text}'}>`

### src/pages/internal-job-detail/InternalJobPartRequirementCard.tsx

- L192: `<Badge variant="secondary" className="border border-border bg-accent text-foreground">`
- L195: `<Badge variant="secondary" className="border border-border bg-accent text-foreground">`
- L211: `<div className="inline-flex items-center gap-2 rounded-full border border-border bg-accent px-3 py-1 text-xs text-foreground">`
- L216: `<div className="inline-flex items-center gap-2 rounded-full border border-border bg-accent px-3 py-1 text-xs text-foreground">`
- L243: `<AlertTriangle className="h-6 w-6 text-foreground" />`
- L300: `<p className="text-xs text-foreground">`
- L329: `<p className="text-xs text-foreground">`
- L358: `<p className="text-xs text-foreground">`
- L480: `<p className="text-xs text-foreground">`
- L575: `<span className="font-medium text-foreground">{item.field}</span>`
- L584: `<div className="mt-5 rounded-2xl border border-border bg-accent p-4 text-sm text-foreground">`
- L592: `<div className="mt-5 rounded-2xl border border-border bg-card p-4">`
- L595: `<Badge variant="secondary" className="border border-border bg-accent text-foreground">`
- L609: `<thead className="bg-accent text-foreground">`
- L619: `<tr key={row.field} className="border-t border-border text-foreground">`
- L632: `<p className="text-xs font-medium text-foreground">Approved spec snapshot</p>`
- L634: `<pre className="mt-2 max-h-52 overflow-auto rounded-xl border border-border bg-muted p-3 text-[11px] text-foreground">`
- L642: `<p className="text-xs font-medium text-foreground">Part queue activity</p>`
- L649: `<Badge variant="secondary" className="border border-border bg-accent text-foreground">`
- L662: `<p className={'mt-2 rounded-lg border border-border px-2 py-1 ${STATUS_TONE.error}'}>`
- L666: `<details className="mt-2 text-foreground">`
- L667: `<summary className="cursor-pointer text-xs text-foreground">Queue payload</summary>`

### src/pages/internal-job-detail/InternalJobPublicationCard.tsx

- L51: `? "border border-border bg-accent text-foreground"`
- L52: `: "border border-border bg-accent text-foreground"`

### src/pages/internal-job-detail/InternalJobVendorCompareSection.tsx

- L90: `<Badge variant="secondary" className="border border-border bg-accent text-foreground">`
- L94: `<Badge className="border border-border bg-accent text-foreground">`
- L99: `<Badge className="border border-border bg-accent text-foreground">`
- L103: `<Badge variant="secondary" className="border border-border bg-accent text-foreground">`
- L109: `<Badge variant="secondary" className="border border-border bg-accent text-foreground">`
- L178: `className="border border-border bg-accent text-foreground"`
- L186: `className="border border-border bg-accent text-foreground"`
- L194: `className="border border-border bg-accent text-foreground"`
- L201: `className="border border-border bg-accent text-foreground"`
- L223: `<p className="mt-1 text-foreground">{formatCurrency(offer.unitPriceUsd)}</p>`
- L227: `<p className="mt-1 text-foreground">{offer.material || "N/A"}</p>`
- L231: `<p className="mt-1 text-foreground">{offer.finish || "N/A"}</p>`

Inventory: 249 changed source lines with color/typography classes or shared-tone references.

## Validation

Final verification: Vitest 238 files / 3,056 tests passed, real exit 0 (56.62s); typecheck exit 0; ESLint on all 35 changed TS/TSX files exit 0; git diff --check passed. HEAD remains de1b4475; QuoteSelectionFunctionBar.tsx is unchanged. No Playwright, dependencies or git writes. Raw logs: `/tmp/ovd1032-full-vitest.log`, `/tmp/ovd1032-typecheck.log`, `/tmp/ovd1032-eslint.log`.
