# Design & Procurement Agent

A Node.js + TypeScript backend for a kitchen renovation assistant in Linq iMessage, RCS, and SMS conversations. Contractors and homeowners can text in the same group. The project is assumed to be a kitchen redesign: FORM reviews current-kitchen and inspiration photos, asks about a floor plan and design goals, and waits for a final intake confirmation before using the OpenAI Images API to create the first design.

The editable conversation prompt lives in [`prompts/designer.md`](prompts/designer.md).

## What works

- Signed Linq webhooks, sender-aware group conversations, and replies to the originating chat.
- Direct-message senders and group participants matched to contractor signups, with saved names/practices, isolated project briefs, and a persistent contractor assignment when exactly one match exists.
- OpenAI Responses with structured decisions and image/PDF input. Default chat model: `gpt-5.6-terra`. Kitchen renders use the Images API (`OPENAI_IMAGE_MODEL`, default `gpt-image-2.5-sunburst`).
- PostgreSQL conversation history, project briefs, handoffs, and durable queued replies.
- Debouncing, duplicate-event protection, per-chat serialization, retries, and stable Linq send idempotency keys.
- Human takeover, pause/resume, explicit STOP handling, operator messages, and failed-turn inspection.
- Phone-restricted `/help`, `/reset` (`/new`), `/pause`, `/resume`, and `/status` commands in live chats, plus private `/contractor` and `/client` role sessions.
- A public contractor landing page and signup flow, with a Messages handoff and downloadable FORM contact card.
- A sandbox web UI and `npm run chat` that exercise the same backend without sending real texts.
- Render Blueprint, PostgreSQL, health checks, graceful shutdown, and deployment after GitHub checks pass.

A `design` handoff sends a brief progress message, generates a kitchen image from the conversation photos and notes, and attaches it to FORM's reply in both the sandbox and live Linq chats. Generated images are stored in PostgreSQL so delivery retries and later revisions can reuse them after a restart. Proposal and procurement handoffs still create database records for an operator. This backend does not fetch live catalog prices, produce binding proposals, buy materials, notify an external team, or place calls.

FORM asks one useful question at a time, distinguishes the existing kitchen from inspiration, and uses the latest design as the baseline for revisions. Ordinary negative design feedback prompts a revision. FORM never offers human support; only an explicit customer request for a person triggers human takeover. Proposal and procurement requests collect their missing required details one at a time.

In live chats, longer agent replies split into separate texts at sentence/paragraph boundaries, aiming for about 220 characters per text while keeping words, links, and emoji intact. Short replies stay together. Subsequent texts have a one-second pause with a typing indicator; generated images accompany only the first text. Admin command menus and manually composed operator replies stay intact. The sandbox retains one logical reply and never sends live typing events.

Typing starts while FORM prepares a reply, restarts after design-progress messages, and refreshes during longer work. It clears on completion, silence, cancellation, and errors. Typing is best effort, has a short provider timeout, and cannot block delivery on failure. [Linq supports visible typing in iMessage chats](https://docs.linqapp.com/channel/imessage/guides/chats/typing-indicators/); SMS/RCS do not display it, and a first reply after an idle period may not show an indicator.

Migration `009_reply_parts.sql` stores the delivery plan and a receipt for each text. Restarts resume only unfinished parts with their original idempotency keys, without repeating acknowledged texts or images. Pause/reset/new input between texts cancels the remaining parts; already accepted texts remain in the audit history. Model context keeps one logical reply containing only delivered parts, and intake checkpoints become active only after the complete question is delivered. Older saved decisions without a delivery plan retain their original single-message payload for safe retries.

Photo analysis records distinct cabinet runs, supporting attachment IDs, connected corners, layout confidence, islands/peninsulas, and missing views in `brief.kitchenLayout` before composing the reply. Multiple angles of the same run are reconciled using shared landmarks. L-shaped layouts require two connected runs and one corner; U-shaped layouts require three and two. Uncertain views stay tentative, and customer corrections replace earlier guesses. These observations also accompany image-generation requests. Old briefs without this field remain readable; no migration is needed.

The five-file visual budget prioritizes the latest design, newest upload, a known floor plan, and two known current-kitchen views before filling remaining slots. The model gets an explicit inventory of readable attachment IDs. Visual turns on the configured GPT-5.6 family use high reasoning effort and an 8,000-token output allowance; text-only turns retain their existing settings. This can increase response time and token use. Image detail remains `auto`, which already uses original-image sizing on GPT-5.6 ([OpenAI vision documentation](https://developers.openai.com/api/docs/guides/images-vision)); there is no forced resolution downgrade.

Run `npx tsx scripts/eval-kitchen-vision.ts --photos /private/path/view1.png /private/path/view2.png` with `OPENAI_API_KEY` for real-model regression checks against a known L-shaped kitchen, reversed photo order, conflicting prior descriptions, a U-shaped inspiration image, a true U-shaped kitchen with an island, and unavailable media. Alternatively, `--linq-message MESSAGE_ID` reads the fixture photos using `LINQ_API_KEY`. With no arguments, only the public U-shaped example and unavailable-media checks run. Fixtures remain private; the eval sends no messages, generates no designs, and writes no app state, but makes paid model requests.

Direct messages recognize contractor signup phones on the assigned FORM line, including existing chats and signups completed after a chat starts. Matched contractors are greeted by name and saved practice; only unmatched senders default to customers unless they identify themselves as contractors. Admin access alone does not establish a contractor role. FORM briefly acknowledges meaningful choices, connects suggestions to supplied kitchen details, and uses occasional light humor and emojis. The first delivered design invites feedback and changes. Later versions gently offer finalization so the contractor can review selections, order materials, and plan work; hesitation or a request for time stops the nudges.

Explicit customer approval of the latest delivered design creates a `finalization` handoff. It saves the exact image, approval message/sender/time, and a snapshot of the selected materials and brief. Unknown names do not block this milestone. Casual praise, approval of one material, and contractor approval do not finalize the customer's whole design. The operator queue and sandbox Admin panel expose the handoff and approved image. In a group FORM can address the known contractor in its reply; in a DM it says the choices are saved for the contractor. **External contractor notifications, purchasing, and scheduling are not implemented.** Finalization stops further approval prompts but leaves chat available for questions. A requested revision marks previous finalization records `superseded` before rendering, removes them from active work, and requires approval of the new design. Completing an operator handoff does not erase the finalized milestone; `/new` starts a fresh one.

## Run locally

Use Node 22 and PostgreSQL 16 or newer. With Docker available:

```sh
nvm use
npm ci
cp .env.example .env
docker compose up -d
```

Edit `.env`: set `OPENAI_API_KEY`, and replace `ADMIN_API_KEY` with a random token of at least 32 characters (`openssl rand -hex 32`). The example database URL matches Docker Compose. Leave `MESSAGING_MODE=sandbox` for local testing; no Linq credentials are needed. Kitchen image generation uses the same OpenAI key.

```sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the contractor landing page, or [http://localhost:3000/signup](http://localhost:3000/signup) for signup. The sandbox is at [http://localhost:3000/sandbox](http://localhost:3000/sandbox). In development the browser is signed in automatically. Switch Homeowner / Contractor, send the property address and kitchen photos, answer the missing intake questions, then reply to the final “anything else?” question to start the first design. Use **Admin** to clear the chat, pause, send an operator note, complete handoffs, or retry a failed turn. The composer stays at the bottom of the page. The sandbox never sends Linq messages.

Migrations run automatically on startup. The same backend is also available from a terminal:

```sh
npm run chat
```

`/as contractor` and `/as homeowner` switch speakers, `/new` starts another project, and `/quit` exits. Point the command at a deployed service with `AGENT_URL=https://YOUR-SERVICE.onrender.com npm run chat` and that service's admin token in your local environment. Both the web UI and the chat command use your OpenAI key and incur model usage.

## Deploy to Render

[Deploy with the Render Blueprint](https://render.com/deploy?repo=https://github.com/kunalgorithm/design-procurement-agent)

1. Connect the GitHub repository and create a Blueprint from `render.yaml`. It provisions a Node web service and PostgreSQL database on **paid plans**; review the plans in Render before creating them.
2. Supply `OPENAI_API_KEY`. Its OpenAI project must allow both `OPENAI_MODEL` and `OPENAI_IMAGE_MODEL` (defaults: `gpt-5.6-terra` and `gpt-image-2.5-sunburst`). Check the project's **Limits → Model usage → Allowed models** settings: successful text replies do not prove image-model access. Render supplies `DATABASE_URL` and generates `ADMIN_API_KEY`. The application initially defaults to sandbox mode, so you can test it before connecting a real messaging line.
3. Confirm `/healthz` and `/readyz` return 200, then verify a real image generation; health checks only check the service and database. Open `/sandbox` on the Render service and sign in with the generated `ADMIN_API_KEY` from the service's environment settings. Send a property address and a kitchen photo, and confirm a generated image appears. This is the same sandbox as local: homeowner/contractor roles, photos, and admin controls, with no Linq delivery. Uploaded sandbox photos live on the instance disk and do not survive deploys or restarts.
4. The same admin token works for `npm run chat` and the operator `/api` routes. Keep the token private; anyone who has it can talk to the model and inspect conversations.
5. Enable Linq as described below. Keep the service at one instance initially; the database queue supports safe per-chat locking during rolling deployments. The web sandbox stays available after you switch to live mode and remains isolated from real chats.

Every push to `main` runs type checking, unit tests, a production build, and PostgreSQL integration tests. `autoDeployTrigger: checksPass` lets Render deploy after the checks succeed. Ensure GitHub Actions is enabled and Render has repository access. Migrations run before the service accepts traffic; queued work survives deploys. Use additive, backwards-compatible migrations so an older process can finish during a rolling deployment.

For the first rollout of migration `005_chat_commands.sql`, enable maintenance mode and let all pending/processing work finish (or stop the old workers) before migrating. Keep public traffic disabled until the new version is live and the old instances have retired. This migration replaces the conversation uniqueness constraint to allow archived sessions; older versions cannot ingest messages against that new constraint. Existing conversations, messages, briefs, media, and queued work are retained. Historical failed turns remain inspectable without sending new failure alerts during rollout. Subsequent restarts of the new version use the normal startup migration flow.

### Connect Linq iMessage / RCS / SMS

Use an active Linq messaging line and its API key. This integration uses the iMessage channel API (which also carries RCS/SMS), not the separate WhatsApp API.

Create a webhook subscription in Linq with:

```text
Target URL: https://YOUR-SERVICE.onrender.com/webhooks/linq?version=2026-02-03
Subscribed event: message.received
```

The URL's `version=2026-02-03` is required. This backend intentionally validates that payload format. If using the REST API, the equivalent request is:

```sh
curl https://api.linqapp.com/api/partner/v3/webhook-subscriptions \
  -H "Authorization: Bearer $LINQ_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"target_url":"https://YOUR-SERVICE.onrender.com/webhooks/linq?version=2026-02-03","subscribed_events":["message.received"]}'
```

Store the returned `signing_secret` securely; Linq returns it only at creation. In Render, add these environment variables and redeploy:

```text
MESSAGING_MODE=live
LINQ_API_KEY=<your Linq API key>
LINQ_WEBHOOK_SECRET=<the subscription signing_secret>
LINQ_ALLOWED_HANDLES=<optional comma-separated owned Linq phone numbers>
```

`LINQ_ALLOWED_HANDLES` filters the agent's owned lines, not the customer phone numbers. You can also scope the Linq subscription using its `phone_numbers` option. The live-mode variables are intentionally not managed by the Blueprint, so a later Blueprint sync does not reset them.

Before switching live, the webhook endpoint returns 503. Complete configuration before testing real traffic. Start a group containing the Linq line, contractor, and homeowner, then send an introduction. The agent responds to incoming messages; it does not create groups or proactively text new contacts. Delivery and group capabilities depend on the participants' available transport and your Linq line.

### Contractor recognition and group intake

Signup accepts an optional company/practice name (`businessName`); previous signups continue working when it is absent. Contractors must use the phone they registered and the FORM number assigned at signup. Initial direct-message turns and every group turn read Linq's current [chat participants](https://docs.linqapp.com/channel/imessage/api/resources/chats/methods/retrieve/), excluding owned, removed, and departed handles. It resolves phone matches within that assigned line, including a contractor who has not spoken yet in a group. Signup lookup runs on every context load, so an existing DM with a cached roster also recognizes a later signup without resetting the chat. Apple ID emails, names typed into messages, and other participants' numbers do not become phone matches. Identical signup retries resolve to one identity; conflicting records remain unresolved. These are signup details, not a license or professional-identity verification.

The first useful group reply introduces FORM to the client as working with their known contractor, mentioning the practice only when saved. Private contractor chats skip the introduction and signup acknowledgment: FORM already works for them and gets straight to their client project. It collects missing project details in the group, directs measurements to the contractor and preferences to the homeowner, and summarizes the brief and waits for a reply to its final intake question before the first design. Details arrive in any order; corrections and attachments remain tied to this group's conversation. Direct messages use the same first-design intake sequence. Unregistered participants are not automatically designated homeowners, and registered contractors cannot approve a design on a homeowner's behalf.

Migration `007_group_contractors.sql` is additive: it adds practice names, a current participant roster, an indexed signup lookup, and a nullable contractor assignment. A single unambiguous contractor is linked to the project; with multiple candidates FORM asks who is leading rather than assigning arbitrarily. A roster refresh does not move a project's ownership to a new contractor. `/new` starts another project in the same Messages thread and resolves its participants again. Group names are display-only; the Linq chat ID routes messages. Existing duplicate-event protection, burst grouping, retries, and saved decisions still apply. A temporary roster lookup failure retries before asking the model or sending a reply. Only model context receives the contractor's name and practice; signup email and license are excluded.

Internal test sequence:

1. Register two testers with different roles: one contractor through `/signup`, one homeowner who does not register as a contractor. If using Linq's shared free line, register/activate both test contacts as required by that line.
2. Create an iMessage group containing both testers and FORM. Send a contractor introduction; confirm recognition and a useful intake question.
3. In another group, let the homeowner speak first. FORM should still recognize the contractor from the roster. Keep practice blank once to confirm it is not invented.
4. Send the address, a few photos, and measurements in a burst. Correct a measurement and confirm that only the missing information is requested.
5. Test two simultaneous projects, a removed participant, a second contractor, and an Apple ID sender. Keep Android/mixed-transport compatibility as a separate handset test.

`npm run check` and `npm run test:integration` cover signed events through persistence and mocked delivery, role resolution, isolation, retries, duplicates, and group changes. To additionally exercise the actual language model with synthetic conversations (no Linq messages or application writes), set `OPENAI_API_KEY` and run `npx tsx scripts/eval-group-intake.ts` or `npx tsx scripts/eval-contractor-dms.ts`. The DM checks cover registered greetings, a missing practice, correction of an old homeowner assumption, client-project intake, and unregistered customer greetings.

### Wait for the complete first-design brief

Both DMs and groups review supplied images, clarify current kitchen versus inspiration only when unclear, ask whether a plan/sketch is available, and gather style OR practical goals. Volunteered details are reused. A declined/unavailable plan is accepted; “more coming” keeps intake pending. Names, budget, and timing stay optional. FORM then summarizes and asks “Anything else you’d like to add before I create your first design?” It waits for a readiness reply; more files or details trigger a fresh checkpoint.

`brief.intake` stores photo/plan/preference status. The server appends the final question and derives `intakeCheckpoint` from the latest completed agent turn with an actually delivered question. A model cannot invent a checkpoint or use an old unrelated yes: its `intakeConfirmation` must reference the latest later user text. Upload-only replies cannot confirm readiness. The checkpoint survives restarts and the recent-history limit; subsequent intake replies clear it, and `/new` starts fresh. Older saved decisions without a checkpoint pass through this gate before a first design. No additional migration is needed for intake; existing JSON records remain readable.

New input during first-intake processing defers the obsolete turn to the already queued newer burst. The worker rechecks before rendering and before delivery. If a render has already started, the external image request may still finish, but an obsolete result is not sent. A message already accepted by Linq cannot be recalled. Later design revisions retain the existing feedback flow and do not repeat initial intake; approving a completed design remains a separate milestone.

Run `npx tsx scripts/eval-initial-intake.ts` with `OPENAI_API_KEY` for opt-in real-model checks using the public sample kitchen. It covers a multi-turn DM, a complete group brief, inspiration-only input, unavailable plans, additional uploads, requests to wait, and final readiness. It makes paid model requests but no image-generation calls, app writes, or Linq sends.

### Admin commands in Messages

Send a command as the entire message, without attachments. Commands apply to the direct message or group where they are sent; everyone in that chat can see the confirmation.

| Command | Effect |
| --- | --- |
| `/help` | List all admin commands, their effects, and private-chat restrictions without changing the current project or pause state. |
| `/reset` or `/new` | Archive the current session and start fresh in the same Messages thread. Clear the agent's active brief, image references, and handoffs; cancel unfinished work from the previous session. Clear any selected role and return to normal signup recognition. |
| `/contractor` | Private chats only: start a fresh project with you as the contractor. FORM skips its introduction and helps with your client project. |
| `/client` | Private chats only: start a fresh project with you as the client, even if your number has a contractor signup. FORM introduces itself and begins client intake. |
| `/pause` | Pause automatic replies and cancel pending or running agent turns. |
| `/resume` | Enable automatic replies for the next incoming message. Cancelled work is not replayed. |
| `/status` | Report active/paused state, working/queued/failed agent request counts, open handoff types, and your role in a private chat. |

`LINQ_ADMIN_NUMBERS` contains the allowed sender phone numbers. Set this privately in the Render service environment as a comma-separated list of international phone numbers; the Blueprint leaves its value unmanaged. Keep real admin phone numbers out of this public repository. An empty or missing setting grants nobody admin-command access. This list is separate from `LINQ_ALLOWED_HANDLES`, which filters FORM's owned messaging lines.

Authorization uses the sender phone handle from a verified Linq webhook, never the message text, a display name, or the group's owned line. Unlisted senders receive an access-denied reply without changing the chat. Commands are handled in the backend without a model call, work while paused, and have durable, idempotent confirmations. Command messages and confirmations are retained for audit but excluded from the model's conversation context. The ordinary `STOP` opt-out remains available to every participant.

Role commands use the same reset flow: a fresh project inside the existing Messages thread, with old context archived and unfinished work cancelled. The choice is bound to the authenticated sender and this private session, survives restarts, and never updates signup records or roles in other chats. `/new` returns to normal signup recognition. Group chats reject role switches. Migration `008_private_chat_roles.sql` adds nullable session fields and leaves existing sessions unchanged.

Reset archives the earlier session instead of deleting the Messages transcript or stored project history. The admin API can list archives with `GET /api/conversations?archived=true` and inspect one by its conversation ID. Its handoffs no longer appear in the active work list. New messages use only the fresh session. A pause or reset prevents later sends from cancelled work but cannot recall a message Linq has already accepted.

## Contractor onboarding

The public flow collects first and last name, phone, email, optional website, and optional contractor license number. The React source is in `web/`; `npm run build:web` compiles it to ignored `public/site/`, served by the same Express app. Frontend requests use this service’s own origin. After frontend edits, rebuild with `npm run build:web` (or run it with `-- --watch` on the Vite command). `npm run dev` builds the frontend before starting the backend.

Set `LINQ_FROM_NUMBER` to the FORM line in E.164 format; the configured shared line is `+12054909563`. Register test contacts with Linq before they text this number; the free shared line allows up to 20 contacts and requires each contact to message first. Optional `FORM_CONTACT_EMAIL` and `FORM_CONTACT_WEBSITE` enrich the contact card. Registration returns 503 if the phone is missing. The service’s existing migration runner creates `contractor_signups` in its own database at startup. A submitted UUID makes retries idempotent and preserves the original details and assigned agent number. The public endpoint is limited to 20 requests per client per 15 minutes.

Successful signup opens a user-initiated `sms:` link and offers a vCard 3.0 download. The device chooses iMessage when available. The contractor still confirms saving the native contact. Registration does not send texts, start a conversation, create password credentials, or expose operator access. Saved progress survives a refresh in the same tab; **Start another signup** clears it for another contractor.

Run `npm run check` to build and test both surfaces, then `TEST_DATABASE_URL=postgresql://... npm run test:integration` against a dedicated test database. Tests use isolated schemas and mock all model and messaging calls.

## API

The contractor landing page is served at `/` (also `/contractors`), signup at `/signup`, and the sandbox web UI at `/sandbox`. In development it reads `/config` and signs in with `ADMIN_API_KEY` automatically. In production `/config` only says that a token is required; paste the admin key into the gate. All operator `/api/*` endpoints require `Authorization: Bearer <ADMIN_API_KEY>`. Treat this as an operator-only credential; don't embed it in a customer-facing app. The contractor signup POST and health checks are public; webhooks use Linq signature verification instead.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/`, `/contractors` | Contractor landing page |
| GET | `/signup` | Contractor signup, Messages handoff, and contact card |
| POST | `/api/contractors/signup` | Public contractor registration; no messages sent |
| GET | `/sandbox` | Operator sandbox web UI |
| GET | `/config` | Whether the UI must prompt for `ADMIN_API_KEY` |
| GET | `/healthz` | Process health |
| GET | `/readyz` | Database readiness |
| POST | `/webhooks/linq` | Signed inbound events; acknowledge after persistence |
| POST | `/api/sandbox/messages` | Test a conversation with no real text delivery; optional photos |
| GET | `/api/media/:id` | Uploaded sandbox photo or saved generated design; admin access required |
| GET | `/api/conversations` | Latest 100 active sessions; `?archived=true` lists archived sessions |
| GET | `/api/conversations/:id` | Brief, latest 40 messages, latest 30 handoffs, and failed turns |
| PATCH | `/api/conversations/:id` | Pause/resume with `{"paused":true}` or `false` |
| DELETE | `/api/conversations/:id` | Clear a sandbox conversation's messages, brief, and queued work |
| POST | `/api/conversations/:id/messages` | Queue an operator's text or link |
| GET | `/api/turns?status=failed` | Latest 100 turns, optionally filtered by status |
| GET | `/api/turns/:id` | Processing state, decision, attempts, and error code |
| POST | `/api/turns/:id/retry` | Retry a failed turn after correcting its cause |
| GET | `/api/handoffs` | Oldest 100 open tasks |
| PATCH | `/api/handoffs/:id` | Complete a task with `{"status":"completed"}` |

Start a sandbox session:

```sh
curl http://localhost:3000/api/sandbox/messages \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"sender":"contractor","message":"Hi, I am Sam, the contractor. Alex is the homeowner."}'
```

The response includes `sessionId`, `conversationId`, and `turnId`. Poll the turn until `done`, then read `turn.decision.reply` (which can be null when the agent stays quiet). Include the returned `sessionId` on later messages. Optionally supply a UUID `requestId` to make retries idempotent. Reusing it with different content returns 409. The sandbox remains isolated even when the server is in live mode. The web UI posts the same route and may include up to five JPEG, PNG, WebP, or GIF attachments as base64 (`attachments: [{ filename, mimeType, data }]`). Photo-only messages are allowed. `DELETE /api/conversations/:id` only clears sandbox conversations.

For an operator message, submit `{"text":"Here is the reviewed design: https://example.com/design","requestId":"<a fresh UUID>"}` to `/api/conversations/:id/messages`. Reuse that UUID only for retries of the same message. On a Linq conversation, **this sends a real text**. Pause automation before taking over. Completing a human handoff does not automatically resume the agent; explicitly set `paused` to false when ready. Resuming waits for the next inbound message rather than replaying cancelled replies.

## Operations and iteration

The request handler verifies the raw webhook signature and persists the inbound event before returning 200. A worker in the same process groups short message bursts, reads the latest history and saved brief, asks the model for a structured decision, and saves it. For a design, it sends a progress update, generates and saves the image, and sends the final text and image together. It records completion after the messaging API accepts the send. The worker processes up to `WORKER_CONCURRENCY` different chats at once (default 3, allowed 1–4) while preserving order within each chat. The sandbox shows progress in the conversation and keeps the composer available for drafting the next message.

Outbound echoes, unrelated events, empty messages, and delayed historical events marked `reconciled_at` are ignored. This version does not import historical chats. Rich link previews are kept as text URLs; their webpages are not fetched.

The decision and generated image are saved **before** final delivery. Linq media is pre-uploaded, its attachment ID is saved, and the turn UUID is reused as `message.idempotency_key`. An ambiguous send can therefore retry the same text and image without another model or image-generation call. Progress and failure notices have their own stable send keys. This relies on Linq's idempotency semantics; API acceptance is not confirmation of handset delivery. An abandoned processing lease becomes recoverable after four minutes. Retries back off and stop after five attempts; most upstream 4xx errors fail immediately. A failed image-generation call retries the saved decision without asking the chat model again.

Image generation has a three-minute request timeout. Image-model access/authentication and exhausted-quota errors stop with `IMAGE_GENERATION_UNAVAILABLE`, preserve the request, and explain that generation is unavailable without encouraging a futile retry. Restore model access or quota before retrying. Failure logs include the processing stage, HTTP status, provider error code, and request ID when available, without logging prompts, image URLs, or raw error bodies.

Inspect `/api/turns?status=failed` and `/api/handoffs` regularly. A terminally failed turn attempts a short recovery message (up to three delivery attempts) and allows later requests to proceed. Replying `try again`, `retry`, or `resend` retries the latest failed request with its saved decision, image, and final-message key. Requests containing new instructions or attachments start a new turn. Obsolete failure notices are suppressed after a newer agent turn completes, and an old failed turn cannot be retried after newer work has started or completed. To take over, pause the conversation and queue an operator message. STOP cancels outstanding automatic turns and pauses the conversation. A pause cannot recall a send Linq has already accepted. The sandbox web UI is the local/Render operator surface for this; it does not replace a customer-facing product.

Generated designs are stored in PostgreSQL and remain available as visual references beyond the recent 40-message text window. The chat model receives up to five image/PDF references, prioritizing the newest uploads and reserving a slot for the latest design. The image generator can use up to 16 supported references, labeled as current kitchen, floor plan, inspiration, or the latest design to revise. If no usable image can be reopened, FORM asks for a fresh JPEG/PNG instead of claiming to have produced a design.

Original Linq photos remain CDN references, and uploaded sandbox photos remain on instance disk. Those original uploads are not a permanent project photo library. Recent JPEG, PNG, WebP, GIF, and PDF attachments can be passed to the chat model (at most 20 MB each); image generation supports JPEG, PNG, and WebP. Older Linq links expire; observations and image roles retained in the brief survive. A media-related bad request gets one text-only retry so the agent can ask for another upload. Audio, video, HEIC, and other formats need a description or supported upload. Add durable original-upload storage and image conversion before relying on a permanent project photo library.

Conversation content and briefs live in PostgreSQL. OpenAI requests use `store:false`; this does not override provider retention policies. Logs contain turn IDs and error categories rather than customer messages or API keys. The admin API is a single-operator backend without tenant accounts. Sandbox chats can be cleared from the web UI or `DELETE /api/conversations/:id`.

| Change | File |
| --- | --- |
| Personality, introduction, reaction choices, intake questions, group etiquette | `prompts/designer.md` |
| Brief fields and handoff rules | `src/domain.ts` |
| Model choice and image input | `src/agent.ts`, `OPENAI_MODEL` |
| Kitchen image generation | `src/design.ts`, `OPENAI_IMAGE_MODEL` |
| Linq webhook mapping and outbound messages | `src/linq.ts` |
| Admin command parsing, authorization, and session reset | `src/chat-commands.ts`, `src/config.ts`, `src/app.ts`, `src/store.ts` |
| HTTP endpoints | `src/app.ts` |
| Contractor landing page and signup UI | `web/` |
| Sandbox web UI | `public/index.html`, `public/app.js`, `public/styles.css` |
| Persistence and queue behavior | `src/store.ts`, `src/worker.ts` |
| Database changes | New numbered SQL file in `migrations/` |
| Hosting and deploy behavior | `render.yaml`, `.github/workflows/ci.yml` |

The prompt is reread on each turn, so local prompt edits take effect immediately. Use **New chat** in the web UI or `npm run chat` with `/new` to compare a fresh conversation. In production, commit and push to `main` to send changes through CI and Render.

To change FORM's personality, edit **Voice**, **First conversation reply**, and **Message reactions** in `prompts/designer.md`. The default introduction is "Hi, I'm FORM. I'm an AI agent that can help you design your new kitchen." It appears in the first useful client-facing reply; private contractor chats skip it, and existing chats keep their history and do not restart the introduction. A new sandbox chat is the simplest way to preview it.

FORM can add an occasional ❤️, 👍, 😊, 🙌, ✨, or 👋 reaction to the latest incoming iMessage, including in groups. Reactions are separate from emojis in reply text. SMS and sandbox chats skip native reactions. Each turn attempts its reaction at most once; a reaction failure is logged and does not block the reply. To change the allowed emoji set, update `reactionSchema` in `src/domain.ts` as well as the prompt. These personality settings do not change `OPENAI_MODEL` (`gpt-5.6-terra`).

## Tests

```sh
npm run check
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/design_procurement_agent npm run test:integration
```

Prefer a dedicated database for integration tests. Each run creates and drops its own isolated schema; existing application tables are not truncated. Tests use real PostgreSQL and mocked model/messaging transports, so no paid API keys or real sends are involved. They cover signatures and replay protection, sender identity, burst coalescing, cross-project isolation, durable text/image retries, progress ordering, concurrent chats, recovery messages, restart recovery, visual context, human takeover, handoffs, API authentication, sandbox behavior, both phone-based admins, command denial, reset isolation, and suppression of cancelled render results. Finalization coverage includes approval/image binding, delivery retries, retained outcomes after history truncation, revised designs superseding old approvals, and session resets.

For an opt-in dialogue check with the configured OpenAI model, run `node --import tsx --env-file-if-exists=.env scripts/eval-design-dialogue.ts`. This makes paid model requests using synthetic conversations and the public sample kitchen; it never sends Linq messages, generates images, or writes application data. It checks first versus later presentation, casual praise, explicit and conditional approval, requests for time, post-finalization thanks, and group participant roles. Review the printed replies for warmth, grounded acknowledgments, and restrained humor as well as the behavioral assertions. Live image delivery still needs its separate configured-account smoke test.

A newer customer message arriving while finalization is being processed defers approval to the next turn. The worker checks again when saving the handoff, so a message arriving during delivery cannot leave stale contractor work active. As with STOP, a text already accepted by Linq cannot be recalled; its audit message is retained while the later feedback is processed.

## API references

- [Linq iMessage API](https://docs.linqapp.com/channel/imessage/api/)
- [Linq webhook guide](https://docs.linqapp.com/channel/imessage/guides/webhooks)
- [Linq send-message endpoint](https://docs.linqapp.com/channel/imessage/api/resources/chats/subresources/messages/methods/send)
- [Linq iMessage reactions](https://docs.linqapp.com/channel/imessage/guides/messaging/reactions/)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
