# Lawful CAD-neutral execution-capacity marketplace: opportunity map

## Thesis and current verdict

There may be value in matching CAD-workflow demand with organizations that already possess compatible, authorized software capacity and qualified operators. The safe product is **not “rent your idle seat.”** It is closer to a controlled services marketplace in which a vetted organization performs a defined CAD workflow under an entitlement model that the software vendor and customer contract explicitly permit.

Current verdict: **discovery only; no implementation or provider onboarding.** License rights, identity, automation permission, data handling, export control, professional responsibility, and output ownership are gating conditions. This is not legal advice; vendor-specific counsel and written vendor confirmation are required before any real validation.

## Likely value

- Reduce waiting time for format-specific updates, conversions, drawing generation, and rule-based native checks.
- Let teams buy a result without adopting another CAD stack.
- Create a traceable bridge between a source-neutral decision workspace and a vendor-specific native execution step.
- Increase utilization for qualified engineering service providers without claiming that the underlying license itself is transferable.

## Roles

| Role | Responsibility |
|---|---|
| Requesting organization | Owns or is authorized to use the input IP; defines the exact workflow and acceptance criteria; classifies export/control sensitivity. |
| Execution provider | Supplies authorized users, permitted software entitlement, controlled workstation/tenant, and qualified review. |
| CAD vendor | Defines the license/entitlement model and any automation, hosting, API, contractor, territory, and service-bureau restrictions. |
| OverDrafter | Routes a bounded work packet, records consent and evidence, isolates data, receives outputs, and never represents a license transfer that did not occur. |
| Independent reviewer | Verifies the result when a native action could alter released design intent or create professional/safety risk. |

## Entitlement models to investigate

| Model | Initial assessment | Gate |
|---|---|---|
| Customer assigns its own named seat to a real contractor for the engagement | **Potentially viable for some vendors** | Written contract permits contractor assignment; unique identity; reassignment cadence; territory; customer benefit/internal-use limits. |
| Provider uses its own commercial seat while delivering engineering services | **Most plausible** | License permits service work for third parties; output and IP terms; professional responsibility; export controls. |
| Customer-controlled floating/network license reached by provider | **Narrow** | Authorized-user definition, device ownership/location, LAN/VPN rules, concurrent-use cap, and logging all permit it. |
| Vendor-native Flex/token/capacity plan assigned to an authorized user | **Potentially viable** | Product is included; user is individually authorized; automation/background activity terms; billing transparency. |
| “Idle seat resale” or credential lending to anonymous marketplace workers | **Reject by default** | Common named-user, password, non-transfer, sublicensing, and service-bureau restrictions conflict with this model. |
| Headless automation using desktop UI under a human seat | **Unknown / high risk** | Vendor explicitly permits automation, unattended use, hosting, and the intended commercial service. API terms may differ from desktop terms. |

## Current license evidence

- Autodesk Single User requires a unique Autodesk ID for the actual individual user and allows reassignment only through Autodesk's process. Its general terms prohibit sublicensing, transfer, rental, loan, or making an offering available to a third party except where expressly authorized. Multi User language limits contractor use to stated conditions around premises/devices and internal business needs. [Autodesk offering types](https://www.autodesk.com/company/terms-of-use/en/subscription-types/) · [Autodesk general terms](https://www.autodesk.com/company/terms-of-use/en/general-terms)
- Autodesk separately recognizes capacity-based offerings and Background Activities, suggesting that vendor-native metering—not informal seat resale—is the cleaner route when available. [Autodesk capacity offerings](https://www.autodesk.com/company/terms-of-use/en/offering-types-and-benefits)
- Onshape grants a non-transferable, non-sublicensable right to the ordered service, ties use to the licensed person, prohibits password sharing and unauthorized access, and restricts robots/scrapers or other automated access. [Onshape terms](https://www.onshape.com/en/legal/terms-of-use)
- Dassault Systèmes publishes third-party hosting/outsourcer language that can allow a provider to operate hardware on a customer's behalf only under defined conditions and with duly authorized users; that is not a general right to resell a seat. Current offering-specific terms and the customer's transaction documents still control. [3DS licensed program specifications](https://www.3ds.com/terms/lps)
- SOLIDWORKS' public store distinguishes named-user reassignment from device licenses. [SOLIDWORKS licensing FAQ](https://www.3ds.com/store/solidworks-design)

## Technical isolation model

Minimum acceptable architecture for any later experiment:

1. A clean per-request virtual or physical workspace owned by the authorized license holder.
2. Unique human/service identity; no shared customer credentials.
3. Customer-controlled encryption keys where feasible; encrypted transfer and storage.
4. Default-deny network policy with only vendor licensing endpoints and explicitly required services.
5. No cross-customer clipboard, caches, recent-file history, temp files, fonts, macros, plugins, or model libraries.
6. Malware scanning and file-type validation before native CAD opens the package.
7. Time-bounded access; automatic session revocation and credential/lease cleanup.
8. Deterministic inventory of input bytes, native app/version, plugins, settings, outputs, and cleanup proof.
9. Human verification when output affects released geometry, GD&T, tolerances, or regulated/safety-critical work.

## Evidence and audit model

Every execution should bind:

- requesting organization, execution provider, named authorized user, and entitlement basis;
- source file hashes, filenames, declared sensitivity/export classification, and customer authority;
- exact requested operations and explicit prohibited operations;
- CAD product, release/build, license type, extensions/plugins, locale, units, templates, and configuration;
- start/end timestamps, machine/session identity, network policy, and tool logs;
- before/after file hashes plus preview/diff artifacts;
- warnings, failures, retries, manual interventions, and reviewer disposition;
- deletion/retention outcome and any residual backup policy;
- commercial terms and who bears responsibility for engineering correctness.

Do not record passwords, entitlement secrets, proprietary license files, or sensitive customer content in general-purpose telemetry.

## Risks and discovery gates

| Gate | Pass condition before a real pilot |
|---|---|
| License | Written analysis of the exact SKU/order terms and, where ambiguous, written vendor permission for the service model. |
| Identity | Every operator/agent maps to a unique authorized identity; no credential pooling. |
| Automation | Vendor permits the exact API, macro, UI automation, virtualized, or unattended execution path. |
| Service-bureau use | Terms permit third-party commercial work; no prohibited rental, timesharing, sublicensing, or competitive service. |
| Territory/export | User, machine, data, and output locations satisfy license and trade-control requirements. |
| Data/IP | Requester proves authority; provider NDA/DPA and output ownership are explicit; training/reuse is prohibited by default. |
| Security | Tenant isolation, least privilege, egress control, audit, incident response, and verified cleanup pass an independent review. |
| Engineering responsibility | Scope distinguishes clerical/native execution from licensed professional judgment; acceptance and liability are explicit. |
| Commercial feasibility | Vendor-compliant capacity plus qualified labor and review can beat direct service-provider pricing without hidden risk. |

## Smallest lawful validation experiments

These are sequential; do not skip a gate.

1. **Paper study:** Pick one vendor, one current commercial SKU, one jurisdiction, and one workflow (for example, open a synthetic STEP file and export a neutral preview). Obtain counsel's written entitlement matrix and vendor clarification. No software execution.
2. **Provider interview:** Interview engineering service firms already licensed to perform client work. Use synthetic examples and ask about entitlement, identity, workstation isolation, audit, insurance, and pricing. No customer files or credentials.
3. **Vendor-approved synthetic sandbox:** Only after written permission, run one synthetic, noncommercial file through a provider-owned clean environment. Record the evidence envelope and cleanup proof; do not expose the service publicly.
4. **Customer-owned contractor pilot:** If the vendor explicitly supports contractor assignment, have one customer assign one real named contractor through the vendor's supported admin flow. Use a synthetic part and no autonomous modification. Compare setup time, output fidelity, and audit completeness.
5. **API-first alternative:** Evaluate whether a vendor-supported API, cloud automation product, or official capacity plan delivers the result without desktop-seat delegation. Prefer this when it exists.

## Go / no-go rule

Proceed beyond discovery only if a model is explicitly permitted, uniquely attributable, technically isolated, auditable, commercially useful, and repeatable without credential sharing. If any of those are ambiguous, keep the opportunity as a curated engineering-services referral or vendor-native integration—not an “idle seat” marketplace.
