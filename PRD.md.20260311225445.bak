OverDrafter Product Requirements Document

Last updated: March 11, 2026

Document purpose

This Product Requirements Document (PRD) defines the intended behaviour of OverDrafter.  It is intended to be the single canonical product specification for the application.  The content below consolidates stable requirements derived from the existing repository and product reconstruction work.  Future development should align with this document and evolve it rather than scattering requirements across ad‑hoc notes.

Product summary

OverDrafter is a multi‑role CNC quoting platform that turns uploaded CAD and drawing files into client‑selectable quote packages.  At a high level, the product:
	1.	Allows clients to create part requests and organise them into projects.
	2.	Enables an internal estimating team to review extracted specifications, approve requirements and compare vendor quote results.
	3.	Runs asynchronous extraction and quote orchestration through a worker and queue.
	4.	Publishes curated client‑facing quote packages so that a customer can choose the best option.

Vision statement

Enable a CNC buyer to go from “I have a part and a drawing” to “I selected a vetted quote option” in one workspace, while giving internal estimators full control over review, sourcing, pricing and publication.

Core jobs to be done

For clients
	•	Upload part packages quickly and track them by project.
	•	Organise parts into projects and share them with collaborators.
	•	Review published quote options and select the best option.

For internal estimators
	•	Turn uploaded files into structured part requirements.
	•	Compare automated and manual vendor quotes.
	•	Apply pricing policy and publish curated client packages.
	•	Keep the workflow auditable and operationally visible.

For internal admins
	•	Possess all estimator capabilities.
	•	Manage workspace access and role assignments.

For project collaborators
	•	Access a specific project by invitation.
	•	View and manage only project‑scoped parts without seeing unrelated workspace data.

Product goals

Primary goals
	•	Reduce friction in part intake.
	•	Preserve a strong internal review checkpoint before quoting and publishing.
	•	Centralise vendor comparison in one canonical job record.
	•	Provide a clean client experience for collaboration and selection.
	•	Maintain secure access boundaries between workspaces, projects and internal‑only data.

Secondary goals
	•	Support mixed sourcing models: browser automation, imported spreadsheets and manual intake.
	•	Support long‑running asynchronous work via queues and workers.
	•	Keep an audit trail for sensitive actions.
	•	Make the app usable for both one‑off parts and grouped project workflows.

Non‑goals

The current product does not aim to own:
	•	Direct ordering, procurement or purchase order issuance.
	•	Billing, subscriptions or payment processing.
	•	ERP/CRM synchronisation.
	•	Real‑time chat or threaded messaging.
	•	Full manufacturing execution.
	•	Native mobile applications.
	•	Public marketing CMS functionality.

These may be future opportunities but are not core to the current product.

Product principles
	•	Fast, lightweight intake: uploading a part should be quick and simple.
	•	Explicit internal review: internal estimators must approve requirements before quotes are run or published.
	•	Traceable options: all published client options must be traceable to vendor quotes and pricing policy.
	•	Modelled state transitions: all important workflow transitions should be persisted in the database.
	•	Fail closed: automation failures must not progress a part forward and must remain reviewable.
	•	No data leakage: internal sourcing data must never leak into client‑facing surfaces.
	•	Tenancy concept: workspace is the user‑facing concept; organization and organization_membership remain backend implementation details.
	•	Single workspace per company: assume one workspace per user/company for version 1 and avoid premature multi‑workspace user experience.

Core product flows (high level)
	1.	Client account bootstrap: a signed‑in user with no existing access is automatically bootstrapped into a workspace.  Most users become client.  An allow‑listed email may bootstrap as internal_admin.  For version 1 assume one workspace per user/company.
	2.	Client part intake: clients use a single entry point (e.g., a chat‑like composer) to upload CAD and drawing files and optionally provide a prompt.  The system validates uploads, creates a draft and queues extraction.
	3.	Job/part reconciliation: the backend groups uploaded files into parts, pairs CAD and drawing files where possible and prepares extraction jobs.
	4.	Extraction and estimation: a worker extracts specifications from files, internal estimators approve part requirements and the system orchestrates vendor quotes (automated and manual).  Estimators compare results and apply pricing policy.
	5.	Publication: curated quote packages are published for clients to review and select.  Clients can choose the option that best fits their needs.

Future work

This document captures the stable product requirements as of March 11 2026.  Future enhancements—such as advanced collaboration, integration with other systems or new pricing models—should be added here and prioritised separately.  When adding new sections, include acceptance criteria and update related plan documents accordingly.