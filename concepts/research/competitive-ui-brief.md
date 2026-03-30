# Competitive UI Brief — CNC Quoting & Engineering Platforms

## Reference Applications

### 1. Xometry Instant Quoting
**URL:** xometry.com/quoting
**Primary patterns:**
- Full-width file upload hero on the landing dashboard
- Quote comparison table: vendor name, process, price, lead time, tier badge (Standard / Expedited),
  cert icons (AS9100, ISO 9001), "Add to cart" CTA per row
- Part configuration panel slides in on the right after file analysis
- Green primary action color throughout (matches engineering "go" convention)
- Part number shown in monospace at top of each quote block
- "Best value" / "Fastest" sub-labels on quote rows — the user never has to figure out which is which

**Key takeaway:** The comparison table is the core UI unit. Make it scannable, not interactive.

### 2. Protolabs Dashboard
**URL:** protolabs.com (authenticated)
**Primary patterns:**
- Status step bar: Uploaded → Analyzing → Quoted → Ordered. Always visible in part header.
- Card-based project listing with status badge and part count
- Clean two-panel: sidebar project list + main detail area
- Part cards show thumbnail placeholder + part name + status + price range
- "Download quote" PDF CTA prominent

**Key takeaway:** Status-first. Engineers want to see where things stand before they see prices.

### 3. Fictiv (Protolabs Network)
**URL:** fictiv.com (authenticated)
**Primary patterns:**
- Vertical activity timeline per order — each event is a timestamped node (file submitted,
  reviewed, quote ready, order placed, shipped)
- Actor avatars on each timeline node (who did what)
- "Quote ready" notification-style cards that stack in a feed
- Material/process summary chips below part name
- Relative timestamps ("3 days ago") throughout

**Key takeaway:** Timeline-as-primary-nav works well for engineering workflows where
history and traceability matter. Audit trail is a feature.

### 4. Onshape (PTC)
**URL:** cad.onshape.com
**Primary patterns:**
- Persistent left tree: documents → versions → branches (collapsible, icon-only when narrow)
- Split pane: tree left, 3D viewport right. Tree and viewport are independently scrollable.
- Feature manager shows part tree as a sequential list (chronological operations)
- Floating toolbar on the viewport — no chrome in the model area itself
- Version/revision dropdown in header with branch comparison

**Key takeaway:** Split-pane with spatial navigation is appropriate when the "document" (CAD file,
drawing) is the primary artifact. Engineers are used to this pattern from CAD tools.

### 5. GrabCAD Workbench
**URL:** workbench.grabcad.com
**Primary patterns:**
- File tree with version numbers inline (v1, v2, v3)
- "Checked out by" status on locked files — vault metaphor
- Comment threads anchored to file versions (not to a general feed)
- Upload new version as the primary CTA on any file row

**Key takeaway:** Version-anchored activity (comments, status) is powerful. Engineers need to know
which revision a quote was based on.

### 6. Hubs / Protolabs Network
**URL:** hubs.com
**Primary patterns:**
- Workflow steps shown as numbered phases: 1. Upload → 2. Configure → 3. Get quote → 4. Order
- Large, clear "Get instant quote" button — not buried in a menu
- Material/process configurator as a step in the workflow (not hidden)
- Lead time shown as a calendar date ("Ships by Apr 3") rather than "12 business days"

**Key takeaway:** Numbered workflow steps reduce cognitive load. Calendar-date lead times
are more actionable than day counts.

### 7. Arena PLM (Arena Solutions)
**URL:** arenasolutions.com
**Primary patterns:**
- BOM table: part number, rev, description, qty, unit cost, extended cost — fully sortable
- Change order workflow — parts move through: Draft → Submitted → Approved states
- Lifecycle status column always visible in part table
- Audit log panel on every object (who changed what and when)
- Supplier-facing vs. internal-facing views are distinct tabs

**Key takeaway:** Dual-audience awareness (internal estimators vs. procurement clients) should
influence nav and permissioning patterns.

### 8. SolidWorks PDM Standard
**Desktop app**
**Primary patterns:**
- Checked-in / checked-out state on every file (lock icon)
- Revision history as a tree with diff viewer
- Workflow state machine: Work In Progress → Pending Review → Released → Obsolete
- "Where used" query — which assemblies reference this part
- Vault tree on the left (like a file explorer)

**Key takeaway:** State machine workflows (not just status badges) map well to the quote lifecycle.
Parts move through defined stages with gating conditions.

## Data-Dense vs. Card-Based Trade-offs

| Pattern | Best for | Drawbacks |
|---------|----------|-----------|
| Dense table | Many parts, comparison, scanning | Intimidating at small counts; hard on mobile |
| Cards | Visual scanning, thumbnails, status-at-a-glance | Low density; too much scrolling with 20+ parts |
| Timeline | Audit trail, history, traceability | Doesn't show current state efficiently |
| Split pane | File-centric workflows, CAD review | Requires wide viewport; mobile hostile |
| Command palette | Power users, keyboard-first | Discovery problem for new users |
| Status dashboard | Monitoring, triage, alerting | Too high-level for detailed quoting work |

## Quote Comparison Patterns

**Row-based (Xometry style):**
```
Vendor     | Process      | Price  | Lead   | Tier       | Cert    | [Select]
Xometry    | CNC Mach.    | $487   | 12 d   | Standard   | AS9100  |  ○
Protolabs  | CNC Mach.    | $612   | 7 d    | Expedited  | ISO9001 |  ○
eMachine   | CNC Mach.    | $431   | 18 d   | Economy    |         |  ●
```
- Best for dense comparison of many vendors
- Selected row highlighted with a color ring
- Sub-labels ("Best price", "Fastest") remove mental math

**Card-based (Fictiv style):**
- Each vendor gets a card with large price, lead time, tier chip, and a single CTA
- Works better when comparing 2–4 options; breaks down at 6+

## File/Drawing-Centric Views

Engineers treat drawings as the source of truth. Key patterns:
- Drawing preview (PDF or SVG thumbnail) always in the part detail view
- Part number watermark on placeholder state
- Page count badge (e.g. "3 pages")
- "Open original" link to raw file

## Engineer-Specific UX Expectations

1. **No forced wizards** — engineers want to see all data at once, not step-by-step
2. **Bulk operations** — select multiple parts, apply status change / send to vendor
3. **Keyboard navigation** — tab through table rows, enter to open, escape to close
4. **Copy-paste friendly** — part numbers, prices, and specs should be selectable text (not images)
5. **No loading spinners for static data** — skeleton states only where async data is truly pending
6. **Revision awareness** — always show which revision a quote was based on
7. **Tolerance formatting** — show as ±0.003 in, not "very tight"
8. **Vendor diversity signals** — show cert badges (AS9100, ISO 9001) — they matter for aerospace
