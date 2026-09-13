# Design & Procurement Agent

A Node.js + TypeScript backend for a kitchen renovation assistant in Linq iMessage, RCS, and SMS conversations. Contractors and homeowners can text in the same group. The project is assumed to be a kitchen redesign: FORM asks for the property address and photos (current kitchen, optional floor plan, optional inspiration), then uses the OpenAI Images API to generate a redesigned kitchen from those inputs.

The editable conversation prompt lives in [`prompts/designer.md`](prompts/designer.md).

## What works

- Signed Linq webhooks, sender-aware group conversations, and replies to the originating chat.
- OpenAI Responses with structured decisions and image/PDF input. Default chat model: `gpt-5.6-terra`. Kitchen renders use the Images API (`OPENAI_IMAGE_MODEL`, default `gpt-image-1.5`).
- PostgreSQL conversation history, project briefs, handoffs, and durable queued replies.
- Debouncing, duplicate-event protection, per-chat serialization, retries, and stable Linq send idempotency keys.
- Human takeover, pause/resume, explicit STOP handling, operator messages, and failed-turn inspection.
- A sandbox web UI and `npm run chat` that exercise the same backend without sending real texts.
- Render Blueprint, PostgreSQL, health checks, graceful shutdown, and deployment after GitHub checks pass.

A `design` handoff generates a kitchen image from the conversation photos and notes and attaches it to FORM's reply in the web UI. Proposal and procurement handoffs still create database records for an operator. This backend does not fetch live catalog prices, produce binding proposals, buy materials, notify an external team, or place calls. Generated images are stored on the instance disk with other sandbox media and do not survive deploys or restarts. Live Linq replies remain text-only in this version.

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

Open [http://localhost:3000](http://localhost:3000). In development the browser is signed in automatically. Switch Homeowner / Contractor, send the property address plus current-kitchen, floor-plan, or inspiration photos, and FORM generates a redesigned kitchen. Use **Admin** to clear the chat, pause, send an operator note, complete handoffs, or retry a failed turn. The composer stays at the bottom of the page. The sandbox never sends Linq messages.

Migrations run automatically on startup. The same backend is also available from a terminal:

```sh
npm run chat
```

`/as contractor` and `/as homeowner` switch speakers, `/new` starts another project, and `/quit` exits. Point the command at a deployed service with `AGENT_URL=https://YOUR-SERVICE.onrender.com npm run chat` and that service's admin token in your local environment. Both the web UI and the chat command use your OpenAI key and incur model usage.

## Deploy to Render

[Deploy with the Render Blueprint](https://render.com/deploy?repo=https://github.com/kunalgorithm/design-procurement-agent)

1. Connect the GitHub repository and create a Blueprint from `render.yaml`. It provisions a Node web service and PostgreSQL database on **paid plans**; review the plans in Render before creating them.
2. Supply `OPENAI_API_KEY`. Render supplies `DATABASE_URL` and generates `ADMIN_API_KEY`. The application initially defaults to sandbox mode, so you can test it before connecting a real messaging line.
3. Confirm `/healthz` and `/readyz` return 200. Open the Render service URL and sign in with the generated `ADMIN_API_KEY` from the service's environment settings. This is the same sandbox as local: homeowner/contractor roles, photos, and admin controls, with no Linq delivery. Uploaded sandbox photos live on the instance disk and do not survive deploys or restarts.
4. The same admin token works for `npm run chat` and the `/api` routes. Keep the token private; anyone who has it can talk to the model and inspect conversations.
5. Enable Linq as described below. Keep the service at one instance initially; the database queue supports safe per-chat locking during rolling deployments. The web sandbox stays available after you switch to live mode and remains isolated from real chats.

Every push to `main` runs type checking, unit tests, a production build, and PostgreSQL integration tests. `autoDeployTrigger: checksPass` lets Render deploy after the checks succeed. Ensure GitHub Actions is enabled and Render has repository access. Migrations run before the service accepts traffic; queued work survives deploys. Use additive, backwards-compatible migrations so an older process can finish during a rolling deployment.

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

## API

The sandbox web UI is served at `/`. In development it reads `/config` and signs in with `ADMIN_API_KEY` automatically. In production `/config` only says that a token is required; paste the admin key into the gate. All `/api/*` endpoints require `Authorization: Bearer <ADMIN_API_KEY>`. Treat this as an operator-only credential; don't embed it in a customer-facing app. Health checks are public; webhooks use Linq signature verification instead.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Sandbox web UI |
| GET | `/config` | Whether the UI must prompt for `ADMIN_API_KEY` |
| GET | `/healthz` | Process health |
| GET | `/readyz` | Database readiness |
| POST | `/webhooks/linq` | Signed inbound events; acknowledge after persistence |
| POST | `/api/sandbox/messages` | Test a conversation with no real text delivery; optional photos |
| GET | `/api/media/:id` | Sandbox photo uploaded from the web UI |
| GET | `/api/conversations` | Latest 100 conversations |
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

The request handler verifies the raw webhook signature and persists the inbound event before returning 200. A worker in the same process groups short message bursts, reads the latest history and saved brief, asks the model for a structured decision, saves it, generates a kitchen image when a design handoff is ready, sends the reply, then records completion.

Outbound echoes, unrelated events, empty messages, and delayed historical events marked `reconciled_at` are ignored. This version does not import historical chats. Rich link previews are kept as text URLs; their webpages are not fetched.

The decision is saved **before** calling Linq, and the turn UUID is reused as Linq's `message.idempotency_key`. An ambiguous send can therefore retry the same reply without generating another decision. This relies on Linq's idempotency semantics; it does not guarantee delivery or prevent the provider's own failures. An abandoned processing lease becomes recoverable after four minutes so image generation can finish. Retries back off and stop after five attempts; most upstream 4xx errors fail immediately. A failed image call retries the saved decision without asking the chat model again.

Inspect `/api/turns?status=failed` and `/api/handoffs` regularly. A failed turn blocks later automatic work in that chat until retried or cancelled by pausing the conversation. Other chats can continue. To take over after a failure, pause the conversation and queue an operator message. STOP cancels outstanding automatic turns and pauses the conversation. A pause cannot recall a send Linq has already accepted. The sandbox web UI is the local/Render operator surface for this; it does not replace a customer-facing product.

Linq photos are retained as CDN references, not copied into permanent file storage. Sandbox photos uploaded in the web UI are stored on the instance disk and inlined to the model. Recent JPEG, PNG, WebP, GIF, and PDF attachments can be passed to the model (up to five, at most 20 MB each). Older Linq links expire; observations retained in the brief survive. A media-related bad request gets one text-only retry so the agent can ask for another upload. Audio, video, HEIC, and other formats remain references and need a description or supported upload. Add durable media storage and image conversion before relying on a permanent project photo library.

Conversation content and briefs live in PostgreSQL. OpenAI requests use `store:false`; this does not override provider retention policies. Logs contain turn IDs and error categories rather than customer messages or API keys. The admin API is a single-operator backend without tenant accounts. Sandbox chats can be cleared from the web UI or `DELETE /api/conversations/:id`.

| Change | File |
| --- | --- |
| Tone, intake questions, group etiquette | `prompts/designer.md` |
| Brief fields and handoff rules | `src/domain.ts` |
| Model choice and image input | `src/agent.ts`, `OPENAI_MODEL` |
| Kitchen image generation | `src/design.ts`, `OPENAI_IMAGE_MODEL` |
| Linq webhook mapping and outbound messages | `src/linq.ts` |
| HTTP endpoints | `src/app.ts` |
| Sandbox web UI | `public/` |
| Persistence and queue behavior | `src/store.ts`, `src/worker.ts` |
| Database changes | New numbered SQL file in `migrations/` |
| Hosting and deploy behavior | `render.yaml`, `.github/workflows/ci.yml` |

The prompt is reread on each turn, so local prompt edits take effect immediately. Use **New chat** in the web UI or `npm run chat` with `/new` to compare a fresh conversation. In production, commit and push to `main` to send changes through CI and Render.

## Tests

```sh
npm run check
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/design_procurement_agent npm run test:integration
```

Prefer a dedicated database for integration tests. Each run creates and drops its own isolated schema; existing application tables are not truncated. Tests use real PostgreSQL and mocked model/messaging transports, so no paid API keys or real sends are involved. They cover signatures and replay protection, sender identity, burst coalescing, cross-project isolation, durable retries, restart recovery, human takeover, handoffs, API authentication, and sandbox behavior. Live API delivery and dialogue quality still require a configured account and a human smoke test.

## API references

- [Linq iMessage API](https://docs.linqapp.com/channel/imessage/api/)
- [Linq webhook guide](https://docs.linqapp.com/channel/imessage/guides/webhooks)
- [Linq send-message endpoint](https://docs.linqapp.com/channel/imessage/api/resources/chats/subresources/messages/methods/send)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
