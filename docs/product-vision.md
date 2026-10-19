# Product vision and capability intent

Last updated: October 18, 2026. Source: founder direction (Blaine Wilson), recorded
during the homepage redesign.

This document records what OverDrafter intends to become and how the public
homepage may talk about it. It is **intent, not a plan**. It does not authorize,
prioritize, schedule, or promise any capability.

- `PRD.md` defines stable product intent for the current product.
- `ROADMAP.md` defines the release ladder; only numbered releases own scope.
- The Linear document *OverDrafter Product Portfolio & Future Capability Index*
  is the single detailed home for deferred capabilities. The section
  "Hardware engineering stack vision" there mirrors the list below.
- Listed here means preserved, not promised.

## Mission

Long-range goal (BHAG): **reduce the time to Mars by 10% through creative and
efficient deployment of engineering resources.**

Direction: OverDrafter intends to own the whole design and engineering stack,
from concept and modeling through analysis, inspection, assembly, and
fulfillment, and to do it faster and better than anyone else. The founder's
shorthand for the positioning is "Cursor for hardware"; that comparison is
internal and is not used on public surfaces.

The mission is a goal. Public copy must never present it as progress, a metric,
or a result.

## Capability status

Two capabilities are live. Both are available only in the free, invitation-only
Founding Beta.

| Capability | Status |
|---|---|
| Reads specs from drawings | Live in Founding Beta |
| Quotes in parallel, compared on price and lead time | Live in Founding Beta |

Everything below is a founder-confirmed intention, not an available feature.

| Group | Intended capabilities |
|---|---|
| Text to CAD | Control the founder's own SolidWorks seat (beta first), control any SolidWorks seat, open-source CAD creation, any closed-source CAD editor, a VR CAD service (headset and glasses) |
| Drawings | Drawing creation; drawing checking; datum selection, view selection, detail and section views, notes |
| Sourcing | Best deal on standardized hardware |
| Analysis | Tolerance analysis, every kind of analysis, CFD, DFM, DFA |
| Build | Assembly, assembly instructions generation, inspection |
| Enterprise | PDM, ECO, ERP integration, extensible to anything |
| Channels | Chat bots, Teams, Slack, and other bots |
| Product | Fulfillment, marketplace, provider expansion, team procurement, native apps |

Roadmap routing: Text to CAD, Drawings, Analysis, Build and Enterprise route to
the **CAD & Design Lifecycle** and **Manufacturing Intelligence** incubators;
Sourcing, marketplace, and provider expansion route to **Supplier Network**;
Channels and native apps route to **Native & Cross-platform Apps**; team
procurement is release 2.0. Incubators carry no dates, priorities, or
milestones.

## Public wording rules

These bind the homepage and any other marketing surface that shows this list.

1. **Live** means exactly "Live in Founding Beta". Never a bare "Live".
2. Planned items are labelled "Planned · not available yet" and are visibly
   unpowered (dashed, with an open gap), never distinguished by colour alone.
3. No dates, quarters, years, timelines, percentages, or words such as "next",
   "later", "soon", or "next year". Sequence is shown only by position.
4. Never imply a planned item exists. Never name third-party hardware or product
   brands for planned items.
5. The mission is shown only as a labelled goal.
6. Required closing statement: "Powered nodes are live in the invitation-only
   Founding Beta. Unpowered nodes are our intentions, not commitments."
7. The homepage keeps capability status in one data object
   (`status: "live" | "planned"`) so promoting a capability changes one word.
   A capability may be flipped to live only when it ships and its release gate
   in `ROADMAP.md` is met.

See also: `docs/design/homepage-redesign-plan.md`, `docs/DESIGN.md` (marketing
demo exception), and the truthfulness rule that marketing surfaces carry no
fabricated statistics, logos, compliance badges, or timelines.
