# OverDrafter Mermaid Chart

This diagram reflects the current canonical model described in [README.md](/Users/blainewilson/Documents/GitHub/Overdrafter/README.md) and [ARCHITECTURE.md](/Users/blainewilson/Documents/GitHub/Overdrafter/ARCHITECTURE.md).

```mermaid
flowchart LR
  subgraph Users["Users"]
    Client["Client User"]
    Estimator["Internal Estimator"]
  end

  subgraph Web["Web App"]
    ClientUI["Client Workspace"]
    InternalUI["Internal Review Workspace"]
    Auth["Auth + Route Guards"]
  end

  subgraph Backend["Supabase Backend"]
    RPC["RPC + RLS Layer"]
    DB["Postgres Domain Data
Projects, Parts, Jobs, Quote Requests, Quote Runs, Packages"]
    Storage["Storage Buckets
job-files, quote-artifacts"]
    Queue["work_queue"]
  end

  subgraph Worker["Async Worker"]
    Reconcile["Intake + Reconciliation"]
    Extract["Hybrid Drawing Extraction"]
    Approve["Auto-Approve / Review Routing"]
    Vendors["Vendor Adapters
Xometry, Fictiv, Protolabs, SendCutSend, Manual Import"]
  end

  Client --> Auth
  Estimator --> Auth
  Auth --> ClientUI
  Auth --> InternalUI

  ClientUI -->|"create project/job, upload files, request quote"| RPC
  InternalUI -->|"review requirements, compare quotes, publish package"| RPC

  RPC --> DB
  RPC --> Storage
  RPC --> Queue

  Queue --> Reconcile
  Reconcile --> DB
  Reconcile --> Storage
  Reconcile --> Extract
  Extract --> DB
  Extract --> Approve
  Approve --> DB
  Approve --> Vendors
  Vendors --> DB
  Vendors --> Storage

  DB -->|"client-safe workspace projections"| ClientUI
  DB -->|"internal quote + ops views"| InternalUI
```
