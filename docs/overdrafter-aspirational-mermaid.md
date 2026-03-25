# OverDrafter Aspirational Mermaid Chart

This diagram shows the product's intended long-term shape from [PRD.md](/Users/blainewilson/Documents/GitHub/Overdrafter/PRD.md), [ARCHITECTURE.md](/Users/blainewilson/Documents/GitHub/Overdrafter/ARCHITECTURE.md), [capabilitymap.md](/Users/blainewilson/Documents/GitHub/Overdrafter/capabilitymap.md), and [docs/fulfillment-state-model.md](/Users/blainewilson/Documents/GitHub/Overdrafter/docs/fulfillment-state-model.md).

It intentionally separates the core manufacturing workspace from optional or later integrations such as Stripe, ERP sync, shipping carriers, and supplier systems.

```mermaid
flowchart LR
  subgraph Channels["Entry Channels"]
    Web["Web App
Client + Internal"]
    CAD["CAD Plugins
SOLIDWORKS / Fusion / Onshape"]
    Mobile["Desktop / Mobile Surfaces"]
  end

  subgraph Workspace["Manufacturing Workspace Core"]
    Projects["Projects
Top-level collaboration container"]
    Parts["Parts + Assemblies
Technical structure inside projects"]
    Files["Files + Revisions + Provenance"]
    Requests["Service Request Line Items
manufacturing_quote, DFM, DFA, FEA, drafting"]
    Reviews["Review + Release Coordination
quote review, procurement handoff, approvals"]
    Visibility["Fulfillment Visibility
ordered, production, inspection, shipped, delivered"]
  end

  subgraph Execution["Execution Engine"]
    Intake["Intake + Reconciliation"]
    Extraction["Extraction + Structured Requirements"]
    Quote["Quote Orchestration
multi-vendor lanes, manual import, curation"]
    Eng["Engineering Service Workflows
DFM / DFA / modeling / redrafting"]
    Publish["Client Package Publication + Selection"]
  end

  subgraph Platform["Platform Services"]
    Auth["Auth + Access Control"]
    Domain["Domain API + Workflow Rules"]
    Data["Operational Data Store"]
    Storage["Artifact Storage"]
    Queue["Queue + Worker Runtime"]
    Audit["Audit / Activity / Observability"]
    Notify["Notifications"]
  end

  subgraph Integrations["External Integrations"]
    Vendors["Vendor Adapters
Xometry / Fictiv / Protolabs / SendCutSend"]
    Stripe["Stripe Billing
workspace subscriptions, invoicing, entitlements"]
    ERP["ERP / CRM / Purchasing Systems"]
    Ship["Shipping / Tracking Providers"]
  end

  Web --> Auth
  CAD -.-> Auth
  Mobile -.-> Auth

  Auth --> Projects
  Projects --> Parts
  Projects --> Files
  Projects --> Requests
  Parts --> Requests
  Files --> Intake

  Requests --> Intake
  Intake --> Extraction
  Extraction --> Quote
  Requests --> Eng
  Quote --> Reviews
  Eng --> Reviews
  Reviews --> Publish
  Publish --> Visibility

  Projects --> Domain
  Parts --> Domain
  Files --> Domain
  Requests --> Domain
  Reviews --> Domain
  Visibility --> Domain

  Domain --> Data
  Domain --> Storage
  Domain --> Queue
  Queue --> Intake
  Queue --> Extraction
  Queue --> Quote
  Queue --> Eng
  Domain --> Audit
  Domain --> Notify

  Quote --> Vendors
  Visibility -. manual/imported status .-> ERP
  Visibility -. tracking/status sync .-> Ship
  Auth -. account billing only .-> Stripe
  Domain -. entitlements / plan state .-> Stripe
```

## Reading guide

- The center spine is `Projects -> Parts / Files / Requests -> Review -> Publication -> Fulfillment Visibility`.
- `Service Request Line Items` are the future authoritative unit of work; quote requests become one specialized request path, not the whole model.
- `Stripe` should sit off to the side as account/workspace billing infrastructure, not inside the quoting or procurement lifecycle.
- `ERP`, shipping, and supplier systems should remain separate integrations until OverDrafter intentionally takes on execution ownership.