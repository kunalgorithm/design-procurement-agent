# Contractor platform: design, estimates and job admin by text

Status: proposed implementation plan. Code baseline inspected 14 September 2026. This document does not declare the planned features shipped or production-tested.

## Product outcome

FORM helps contractors and small architecture practices move a kitchen job from the first photos to a clear scope, reviewed estimate, client agreement and organized follow-through. The core service is free. Text is the main interface; clients, contractors and invited collaborators do not need a separate app for ordinary project work. Optional links may handle full-document review, required signing and secure payment.

This is an independent product. No Handoff connection or contractor subscription is part of the plan. Materials sourcing may later support the business, but purchases are optional and the free workflow must remain useful when a contractor buys elsewhere.

The proposed positioning leads with **design support for the next kitchen bid**, with a brief mention of estimates, changes and follow-ups to come. Deliver that broader direction in the stages below. Keep availability accurate in onboarding and agent replies while capabilities roll out. An agent must never claim it created, sent or completed an artifact when it only saved an operator handoff.

## Targeted website copy

The website keeps the original layout, fonts, widths, sections, form structure and visual assets from `ed86094`. The eight text-only edit groups in [targeted website copy edits](targeted-website-copy-edits.md) were applied on 15 September 2026. The broader product features in this plan remain unimplemented.

The selected primary CTA is **Get design support for my next bid**. The proposal follows the benefit → mechanism → specific next action structure in [Julian Shapiro’s landing-page guide](https://www.julian.com/guide/startup/landing-pages). The broader product capabilities below remain implementation plans, not current signup deliverables. Judge conversion by qualified contractors starting a real project, not button clicks alone.

## Current implementation and gaps

The baseline below comes from the application code, not from product copy or inferred model abilities.

| Landing promise / workflow | Current capability | Remaining work |
| --- | --- | --- |
| Get design support for my next bid | Public signup persists contractor details and returns FORM's number. The website offers a user-initiated Messages handoff and contact card. See [contractor routes](../src/contractors.ts) and [signup page](../web/src/pages/contractorSignup.tsx). | Text-based business onboarding; authorized business membership and recovery; ordinary multi-job commands. Existing signup records are not tenant accounts or license verification. |
| Share photos and explore designs | Signed incoming events, image/PDF context, intake confirmation, generated kitchen images, revisions and durable generated-image storage. See [agent](../src/agent.ts), [design](../src/design.ts), [intake](../src/intake.ts) and [worker](../src/worker.ts). | Preserve this flow while adding durable source attachments and linking designs to a job. Retain a useful text-only path when photos are unavailable. |
| Save client decisions | Latest-design approval binds a customer message to the delivered image and saves a brief snapshot; revisions supersede prior finalizations. See [validation](../src/domain.ts), [store](../src/store.ts) and [migration 006](../migrations/006_design_finalization.sql). | Separate product selections, specification checks and commercial approvals. Design approval must never authorize a price, purchase or change order. |
| Make estimates and proposals | The brief stores scope, budget and measurements as text. `proposal` and `procurement` are handoff kinds; `Store.finish` creates database records for an operator. | Structured estimate rows, contractor rates, deterministic totals, revisions, proposal documents and a real send/acceptance flow. There is no live supplier-price or quoting engine. |
| Keep the job organized | Messages, briefs and handoffs persist within a conversation. Participant rosters and signup matches identify contractors. See [group recognition](../src/group-contractors.ts) and [store](../src/store.ts). | Durable jobs independent of conversations; multiple authorized threads per job; contacts, tasks, due dates, reminders, logs and business-wide queries. |
| Track changes, invoices and costs | No change-order, invoice, expense or payment domain exists in [domain types](../src/domain.ts) or the current [migrations](../migrations). | Versioned commercial records, approval rules, balances, payment evidence, cost tracking and clear status reporting. |
| Work reliably through text | Webhook verification, event deduplication, durable turns, per-chat serialization, cancellation, retries and stable send keys exist. [App](../src/app.ts), [Linq adapter](../src/linq.ts), [worker](../src/worker.ts). | Authorization for cross-thread sends, job-level concurrency control, scheduled actions, transport-aware document delivery and action-specific audit records. Current sends reply to an existing chat. |
| Keep project information available | Generated images persist; source attachment metadata is stored with messages. Sandbox originals are disk files; remote inputs are provider references, and the agent limits reuse of older remote media. [Media](../src/media.ts), [agent](../src/agent.ts). | Durable received-file ingestion, retention/deletion rules, safe document access and permission-filtered retrieval beyond the recent-message window. |

Existing operator routes use one administrator token. Preserve them as operator tools; do not expose that token or treat those routes as a contractor-facing account API.

## Architecture decisions

### A job survives changes in its conversations

Add durable `organizations`, `memberships`, `contacts` and `jobs`. Keep `conversations` as messaging sessions. **One durable job supports multiple explicitly linked conversations:** contractor–FORM one-to-one, owner–FORM private threads, shared client groups, and separate or shared architect/designer/consultant conversations. No group is mandatory. A contractor's or architect's private thread may discuss several jobs, with an explicitly selected current job.

Each job has an ID, owning organization, responsible professional, client contacts, address, status and version. Organization ownership is separate from homeowner ownership and commercial approval authority. Thread-to-job links have an audience and permissions; a new link exposes only authorized job records, never a blanket transcript transfer. Never merge jobs because names, phone numbers or addresses resemble one another. For migration, preserve each existing conversation as a distinct job candidate; do not invent ownership when identity is ambiguous. Retain existing messages, finalizations and archives.

Resolve ambiguity before a write: “Jones at Oak Street or Jones at Pine Avenue?” Include the job and document version in consequential confirmations. A chat reset archives the session; it must not erase accepted agreements, payments or other job records.

### Private and client-visible information have different audiences

Authorize every retrieval, mutation and send using the authenticated sender, business membership, job membership and destination thread. Base costs, markup, internal notes and unrelated clients must never enter a homeowner-facing model context. Generate client summaries from an allowed view of the job, not from an unrestricted private transcript.

Separate permission grants:

- **Organization member:** administer the practice or assigned jobs according to their role. Workspace ownership does not authorize acceptance on a client's behalf.
- **Client commercial approver:** accept specified proposals/change orders for that job under the recorded approval policy.
- **External collaborator:** read, comment on or edit explicitly permitted designs, selections, files or scope drafts. An architect, designer or consultant is not a contractor seat or organization member by default. Design input grants neither access to private contractor costs nor authority to accept the homeowner's financial agreement.

Refresh group membership before sharing information. Removing a person prevents future access and sends to that audience; it cannot recall messages already delivered. Self-introduction or group membership alone grants no approval authority. Verify participant/contact relationships and record required commercial approvers per document before sending. With multiple required approvers, default to all; use one authorized representative only when explicitly designated. The first owner's reply must not silently count for everyone. Changing the required approvers or policy supersedes the pending acceptance request; preserve previously accepted agreements as evidence.

### AI drafts; application services own facts and actions

Use the model for intent, extraction, questions, scope drafting and explanations. Application services own units, monetary arithmetic, state transitions, document generation, authorization and external actions.

Persist structured records for scope versions, estimate rows, price sources, proposal snapshots, approvals, changes, tasks, logs, invoices, payment events, expenses and source files. Messages remain evidence linked to those records. Retrieval should answer from these records even after the source message leaves the current 40-message context window.

Extend the current durable queue into an action outbox with job, actor, destination, payload version, authorization evidence and a stable idempotency key. Revalidate the job/document version before execution. Per-chat locks alone are insufficient when two conversations update the same job; use transactions and job-level version checks to prevent stale approvals or conflicting writes. Persist the outcome of ambiguous provider calls so a retry cannot create a second invoice, payment record or send.

### Money and approval rules

- Store currency explicitly and monetary results in integer minor units. Use decimal quantity/rate calculations with documented rounding; do not calculate totals in model prose.
- Keep cost, markup, margin, tax, discount, allowance and sales price distinct. For example, $12,000 cost plus 25% markup is $15,000 price and 20% gross margin before other adjustments.
- Every estimate row has quantity/unit, cost source/date and verification status. Use contractor-approved rates and actual quotes first. Clearly label allowances; unknown pricing is not a current supplier offer.
- Proposal and change-order snapshots are immutable once sent. Corrections create a new version and supersede the pending version; accepted records remain auditable.
- Authorize the exact recipient, scope, amount, terms and version before sending a commercial document. Routine reversible edits need not trigger repetitive permission questions.
- Client acceptance binds the correct approver to the exact document. A design compliment, contractor approval of their own draft or stale “yes” cannot substitute for client acceptance.
- Keep approved sales value, planned cost, committed purchases, actual expenses, invoiced amount and received cash separate. A client invoice is not an expense, and a payment claim is not confirmed settlement.
- Keep purchase authorization separate from design/proposal acceptance. Purchasing is outside the initial release.

## Milestones and suggested implementation PRs

Sequence is dependency-based, with no calendar promises. Each slice should include its migration, service behavior, focused validation and README update. Ship behind explicit capability flags where incomplete actions could otherwise be presented as available.

### Milestone A — Durable jobs and safe multi-thread work

**PR 1: Job model and migration**

Introduce organizations/memberships, contacts, jobs and job links; backfill existing conversations without merging their histories. Preserve current design behavior and operator inspection.

Acceptance checks:

- Existing designs and finalizations remain accessible after migration and restart.
- Two jobs with the same client name or address stay separate.
- Resetting a chat does not delete its job or accepted records.
- Migration is additive and supports the deployment/rollback strategy documented for the change.

**PR 2: Text onboarding, job selection and audience permissions**

Add business setup and job creation/selection through text for contractors and small architecture practices. Explicitly link authorized owner and collaborator private/group conversations to the same job. Provide direct-thread operation when a group is unavailable. Restrict job information by audience before model calls.

Acceptance checks:

- A contractor can create two jobs and switch between them through natural language.
- An ambiguous request causes clarification without mutating either job.
- Private rates and notes never appear in client context, summaries or responses.
- Forged identities, wrong owned lines and removed/unauthorized participants cannot gain job access.
- Linking or relinking a thread requires authority and cannot silently transfer historical private content.
- An invited architect can comment on a shared design without gaining organization membership, private cost access or client financial approval rights; edit permissions are separately granted.
- Multiple owners can use separate threads; only the recorded required approvers can complete the document's acceptance policy.

**PR 3: Durable source files and approved actions**

Persist required received files with sender/message linkage and retention controls. Add job-version checks and an action outbox on top of existing turn processing. Preserve opt-out, operator takeover and retry behavior.

Acceptance checks:

- Required files reopen after restart without depending on a temporary source URL.
- A late correction from another job thread invalidates a pending stale action.
- A permitted revision from an owner or collaborator conversation appears in every authorized view of that job; comments alone do not mutate the design. Superseded artifact versions cannot receive valid new approvals from another group.
- Duplicate events and uncertain send responses do not duplicate side effects.
- Cancellation and opt-out prevent unsent scheduled/client actions, with already accepted sends retained in the audit record.

**Release gate A:** A pilot contractor can operate a durable job in private and client conversations without leaking information, losing history or depending on group availability.

### Milestone B — Reviewed estimates and real proposals

**PR 4: Scope, rates and deterministic estimate service**

Add estimate sections/rows, units, reusable contractor rate books, allowances, taxes/markup settings and version diffs. Begin with supported kitchen scopes. Connect current design selections as referenced inputs; verify physical specifications independently.

Acceptance checks:

- A text scope and contractor rates produce an itemized estimate with reproducible totals.
- Missing consequential quantities/prices remain visible and block release as a reviewed quote.
- Tests cover rounding, unit conversion, waste, discounts, markup versus margin and configured tax application.
- Editing a quantity updates only the intended estimate/version and exposes the price difference.
- Historical supplier/contractor quotes retain their source/date and are never relabeled as live pricing.

**PR 5: Client proposal, document access and acceptance**

Generate a client-facing proposal from a reviewed estimate, with contractor identity, scope, exclusions, exact total, terms and payment schedule. Add authorized send, document review and acceptance records. Links must grant only the intended document access; required signing can use a secure no-app review flow.

Acceptance checks:

- Contractor edits and previews the exact client version through text, then sends it to the confirmed destination.
- Client questions do not modify the commercial agreement without contractor review.
- Acceptance records document hash/version, identity evidence and timestamp; expired, superseded or already withdrawn proposals cannot be newly accepted.
- No internal cost/markup data leaks through the document, metadata or share link.
- Draft, sent, accepted, declined and canceled states reflect stored events rather than model inference. Provider acceptance is not presented as proof of reading.

**Release gate B:** A contractor completes one supported job from scope intake to a reviewed estimate and client-accepted proposal through messaging, using a link only where document review/signing needs it. No operator database handoff is described as a sent proposal.

### Milestone C — Changes, invoicing and useful job admin

**PR 6: Change orders and invoices**

Add versioned changes linked to the accepted proposal, partial/milestone invoicing, credits and a payment ledger. Start with contractor-confirmed offline receipts; add hosted online payment as a separate provider-backed slice when selected.

Acceptance checks:

- An approved $650 change adds $650 once, without rewriting the original proposal.
- A $3,000 invoice with a confirmed $1,000 receipt leaves $2,000 outstanding; duplicate receipt events do not reduce it twice.
- Existing invoices and credits are checked before billing a milestone again.
- A client's “I paid” creates a verification task rather than silently settling the balance.
- Online payment, if enabled, uses verified provider events and supports failures, partial payment and reversals. Card/bank credentials are never requested in group text.

**PR 7: Tasks, reminders, daily logs and attention summaries**

Add owned tasks and due dates, private logs, explicitly shared client updates, scheduled follow-ups and “what needs me today?” queries. Reminder rules use a durable scheduler and current document status. Add simple proposed/confirmed schedule events before complex dependencies.

Acceptance checks:

- A due task survives restart and appears in the correct contractor's attention summary.
- Reminders cancel on resolution, opt-out, cancellation or a dispute that requires review; pause/snooze and timezone handling are tested.
- A private site note produces only the contractor-authorized client update.
- Suggested dates remain proposed until the responsible party confirms them.
- A summary does not claim to know conversations or events FORM never received.

**PR 8: Expenses, cost visibility and closeout**

Add explicit cost entries and reviewed receipt extraction, duplicate detection, category/job mapping and punch-list records. Report known actual costs with completeness caveats rather than presenting interim cash difference as final profit.

Acceptance checks:

- Extracted receipt totals and job assignments require review before posting; explicit contractor entries support correction.
- Costs, client invoices and payment receipts cannot be double-counted across ledgers.
- A closed punch-list item does not close an unpaid invoice or unresolved material claim.
- Project records and exports remain useful without purchasing materials through FORM.

**Release gate C:** The free pilot handles a complete supported job, including an accepted change, invoice, partial receipt, follow-up and closeout, with auditable records and no compulsory app or purchase.

### Later independent slices

Add richer scheduling dependencies, crew time, larger plan takeoffs, broader catalogs, supplier quote comparisons and materials ordering only after the core loop is reliable. Each requires its own acceptance criteria and operating responsibilities. Do not bundle an entire financial/project-management platform into one implementation PR.

## Cross-cutting release checks

- Preserve the existing intake, design, finalization, signup recognition, retry and isolation behavior covered in [unit tests](../tests) and [integration tests](../tests/integration).
- Run `npm run check` and the PostgreSQL integration suite using a dedicated test database. Use focused domain tests for financial invariants, migrations, authorization and concurrent updates; mocked messages alone cannot validate handset delivery.
- Run real-device pilot checks for supported direct-text and group transports, photo fallback, unsupported attachments and secure links. Keep ordinary direct texts a complete fallback.
- Test failure recovery: model/provider timeout, stale job version, duplicate webhook, worker restart, recipient removal, opt-out and expired document link.
- Update [README](../README.md), agent instructions and capability flags with each completed milestone. Record measured acceptance results before calling that capability available to the pilot.
- Keep a feature kill switch and operator recovery path. Operators should see the pending action, exact approved payload and failure state without reconstructing a whole conversation.
- Measure cost per active contractor/job: messaging and recipients, model/image use, storage and human intervention. The free core has no subscription gate; optional materials contribution must be measured separately from gross order value.

## Messaging and reference notes

“By text” describes the experience. Literal SMS carries text; images and SMS-path groups use MMS, and a provider may use RCS or iMessage when available. Carrier group limits vary. Do not rely on group read receipts or advertise universally supported group SMS. The current application only replies to existing chats; creating/inviting additional threads is new work. [Linq protocol selection](https://docs.linqapp.com/channel/imessage/guides/messaging/protocol-selection/) and [group chats](https://docs.linqapp.com/channel/imessage/guides/chats/group-chats/), checked 14 September 2026.

Handoff's public workflow is a useful functional reference for linked projects, estimates, proposals and invoices; its quantity guidance also makes clear that missing measurements can produce assumptions. This plan reproduces useful contractor outcomes with FORM's own services and verified inputs. [Project lifecycle](https://help.handoff.ai/en/articles/14668524-getting-started-with-handoff-how-a-project-works-from-start-to-finish), 17 July 2026; [quantity calculations](https://help.handoff.ai/en/articles/9778473-understand-quantity-calculations), 8 September 2025. Source descriptions are not independent benchmarks or guarantees.
