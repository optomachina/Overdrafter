# Prepared dimension conversation

OVD-492 adds a bounded local conversation before the existing prepared-dimension
evaluation request. The user selected a conversation-led internal engineering
workspace with visible CAD, clarification questions and explicit decisions.
This module supplies the proposal step; OVD-493 supplies native STEP exports and
OVD-494 supplies the integrated interface. The broader general engineering
planner remains incomplete.

## Supported conversation

The interpreter accepts a closed set of direct depth requests, such as
`Set the depth to 8 mm` or `Make it 8 millimeters`. `Make it thicker` asks for an
exact target. A bare `8` asks for units; a subsequent `mm` completes that pending
number only in the same assembly context. A request without prepared context
asks for it first. Values must stay within the declared 6–10 mm range.

This slice admits only the existing synthetic fixture's `baseline-depth`
dimension in millimeters, with an exact **5 mm baseline** and a 6–10 mm target
range. The prepared-workflow context validator pins those values; they are not
arbitrary dimensions or limits discovered from an imported assembly. Confirmation
preserves that same fixture boundary. Supporting another baseline requires a
separately qualified context and operation contract.

This is a deterministic prepared-operation interpreter. It makes no model
inference call and does not provide general engineering reasoning. Multiple
values, unsupported units or operations, negation, conditional requests and
relative adjustments receive an explicit unsupported response. It never selects
the first number from arbitrary prose or invents missing units.

## Authority and state

Sending text produces a clarification, proposal or unsupported response. It does
not accept intent, start CAD, create a worker task or change a native file. A
proposal binds the exact context digest, baseline depth and requested depth.
Explicit confirmation rechecks all three against the validated workbench before
the caller queues and persists the request. Failed persistence must keep the
proposal available and must not display a successfully saved decision.

The existing prepared request/result wire, five-decision capacity, native
verification and unadopted state remain unchanged. Concise visible progress
describes observed application state; it does not simulate hidden reasoning or
claim a live SolidWorks connection.

Expected context, baseline and range validation failures receive their specific
actionable explanation. Unexpected validation errors receive a generic recovery
message; internal implementation errors are not copied into the conversation.

## Verification and withdrawal

The focused corpus covers supported phrases, context/value/unit clarification,
stale continuations and proposals, ambiguity, negation, scope, limits and runtime
workbench validation. The existing prepared-workflow corpus must still pass.
There is no migration or external API change. Withdrawing the interpreter/UI
does not alter saved accepted requests or native evidence.
