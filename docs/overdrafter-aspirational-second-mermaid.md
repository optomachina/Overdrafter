# OverDrafter Aspirational Mermaid Chart v2

This version emphasizes the product model over the current implementation shape.

```mermaid
flowchart LR
  subgraph Channels["Entry Channels"]
    Client["Client Users"]
    Internal["Internal Team"]
    CAD["CAD Plugins"]
    Mobile["Desktop / Mobile"]
  end

  subgraph Core["Manufacturing Workspace Core"]
    Workspace["Workspace / Project"]
    Structure["Parts / Assemblies / Files"]
    Requests["Service Request Line Items"]
    Flows["Execution Flows
manufacturing quote, DFM, DFA, drafting, sourcing"]
    Review["Review / Procurement Handoff"]
    Publish["Publication / Selection"]
    Visibility["Downstream Visibility
approved, ordered, in production, shipped, delivered"]
  end

  subgraph Platform["Platform Services"]
    Auth["Auth + Access Control"]
    Domain["Domain API + Workflow Rules"]
    Data["Operational Data"]
    Storage["Artifact Storage"]
    Queue["Queue + Worker Runtime"]
    Audit["Audit / Activity / Observability"]
    Notify["Notifications"]
  end

  subgraph External["External Systems"]
    Vendors["Vendor Adapters"]
    Stripe["Stripe
subscriptions, invoicing, entitlements"]
    ERP["ERP / Purchasing"]
    Shipping["Shipping / Tracking"]
    Supplier["Supplier Portals"]
  end

  Client --> Auth
  Internal --> Auth
  CAD -.-> Auth
  Mobile -.-> Auth

  Auth --> Workspace
  Workspace --> Structure
  Workspace --> Requests
  Structure --> Requests
  Requests --> Flows
  Flows --> Review
  Review --> Publish
  Publish --> Visibility

  Workspace --> Domain
  Structure --> Domain
  Requests --> Domain
  Flows --> Domain
  Review --> Domain
  Publish --> Domain
  Visibility --> Domain

  Domain --> Data
  Domain --> Storage
  Domain --> Queue
  Domain --> Audit
  Domain --> Notify

  Queue --> Flows
  Flows --> Vendors
  Flows -. supplier automation .-> Supplier
  Visibility -. manual or imported status .-> ERP
  Visibility -. tracking updates .-> Shipping
  Auth -. account billing .-> Stripe
  Domain -. plan state / entitlements .-> Stripe
```

Key reading:

- `Project` remains the top-level customer-facing container.
- `Service Request Line Items` are the future authoritative unit of work.
- Quote orchestration is one execution flow inside the broader manufacturing workspace.
- Stripe is intentionally sidecar infrastructure, not part of the quote-to-procurement spine.
- Downstream fulfillment states are visibility-oriented until OverDrafter deliberately takes on execution ownership.
