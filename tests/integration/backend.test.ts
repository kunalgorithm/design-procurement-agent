import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { pino } from 'pino';
import { migrate } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Worker } from '../../src/worker.js';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { type Agent, type AgentContext, type Attachment, type Messenger } from '../../src/domain.js';
import { type DesignStudio } from '../../src/design.js';
import { writeSandboxMedia } from '../../src/media.js';
import { incoming, decision, event, sign, webhookSecret } from '../fixtures.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test database');
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const store = new Store(pool, 0);
const logger = pino({ level: 'silent' });
const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32', OPENAI_API_KEY: 'not-a-real-key',
  MESSAGING_MODE: 'live', LINQ_API_KEY: 'not-a-real-key', LINQ_WEBHOOK_SECRET: webhookSecret });
const app = createApp(config, store);
const auth = { Authorization: `Bearer ${config.ADMIN_API_KEY}` };
const sent: { chatId: string; text: string; key: string }[] = [];
const messenger: Messenger = { async send(chatId, text, key) { sent.push({ chatId, text, key }); return `provider-${key}`; } };
const agent: Agent = { async respond() { return decision(); } };
const worker = (model = agent, transport = messenger, design?: DesignStudio) => new Worker(store, model, transport, logger, 100, 'live', design);
const readyAgain = (id: string) => pool.query("UPDATE turns SET lease_until=now()-interval '1 second',available_at=now() WHERE id=$1", [id]);

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('TRUNCATE conversations,webhook_events CASCADE'); sent.length = 0; });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('migrations are repeatable', async () => {
  await migrate(pool);
  assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '2');
});

test('duplicate event and message deliveries enqueue and respond exactly once', async () => {
  const message = incoming();
  const first = await store.ingest(message, 'linq');
  const duplicate = await store.ingest(message, 'linq');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.turnId, first.turnId);
  assert.equal((await store.ingest({ ...message, eventId: randomUUID() }, 'linq')).duplicate, true);
  await worker().tick();
  assert.equal(await worker().tick(), false);
  assert.equal(sent.length, 1);
  assert.equal((await store.context(first.conversationId!))?.messages.length, 2);
});

test('bursts are coalesced, group participants are retained, and the brief persists', async () => {
  const first = incoming();
  const queued = await store.ingest(first, 'linq');
  const second = await store.ingest(incoming({ chatId: first.chatId, sender: '+12025550102', text: 'I am the homeowner, Alex.' }), 'linq');
  assert.equal(second.turnId, queued.turnId);
  let observed: AgentContext | undefined;
  await worker({ async respond(ctx) { observed = ctx; return decision({ brief: { ...ctx.conversation.brief, homeownerName: 'Alex', goals: ['More storage'] } }); } }).tick();
  assert.equal(observed?.messages.length, 2);
  assert.notEqual(observed?.messages[0]?.sender, observed?.messages[1]?.sender);
  assert.equal((await store.getConversation(queued.conversationId!))?.brief.homeownerName, 'Alex');
  assert.equal(sent.length, 1);
});

test('concurrent webhook deliveries cannot fork one project into duplicate turns', async () => {
  const message = incoming();
  const results = await Promise.all(Array.from({ length: 8 }, () => store.ingest(message, 'linq')));
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal((await pool.query('SELECT count(*) FROM turns')).rows[0].count, '1');
});

test('project histories stay isolated, including the same external ID across sandbox and Linq', async () => {
  const chatId = randomUUID();
  const real = await store.ingest(incoming({ chatId, text: 'Private real project' }), 'linq');
  const sandbox = await store.ingest(incoming({ chatId, text: 'Sandbox project' }), 'sandbox');
  assert.notEqual(real.conversationId, sandbox.conversationId);
  assert.deepEqual((await store.context(real.conversationId!))?.messages.map((message) => message.text), ['Private real project']);
  assert.deepEqual((await store.context(sandbox.conversationId!))?.messages.map((message) => message.text), ['Sandbox project']);
  await worker().tick(); await worker().tick();
  assert.equal(sent.length, 1);
});

test('two workers serialize the same chat while allowing new inbound messages to queue', async () => {
  const message = incoming();
  const first = await store.ingest(message, 'linq');
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const active = worker({ async respond() { started(); await gate; return decision(); } }).tick();
  await entered;
  const second = await store.ingest(incoming({ chatId: message.chatId, text: 'One more detail' }), 'linq');
  assert.notEqual(first.turnId, second.turnId);
  assert.equal(await worker().tick(), false);
  release(); await active;
  await worker().tick();
  assert.equal(sent.length, 2);
  assert.equal((await store.getTurn(second.turnId!))?.status, 'done');
});

test('an ambiguous send retries the saved decision and the same Linq idempotency key', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  let modelCalls = 0;
  const model: Agent = { async respond() { modelCalls++; return decision(); } };
  const deliveries = new Set<string>(); const attempts: string[] = [];
  const transport: Messenger = { async send(_chat, _text, key) {
    attempts.push(key); deliveries.add(key);
    if (attempts.length === 1) throw new Error('Connection lost after provider accepted message');
    return `provider-${key}`;
  } };
  await worker(model, transport).tick();
  assert.equal((await store.getTurn(queued.turnId!))?.decision?.reply, decision().reply);
  await readyAgain(queued.turnId!);
  await worker(model, transport).tick();
  assert.equal(modelCalls, 1);
  assert.equal(deliveries.size, 1);
  assert.deepEqual(attempts, [queued.turnId, queued.turnId]);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('a stale lease is recovered after restart without regenerating a saved decision', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  const claimed = await store.claim(); assert.ok(claimed);
  await store.saveDecision(claimed.turn.id, decision());
  await store.release(claimed);
  await readyAgain(queued.turnId!);
  await worker({ async respond() { throw new Error('Should use persisted decision'); } }).tick();
  assert.equal(sent.length, 1);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('STOP during model generation cancels the reply and pauses subsequent automatic replies', async () => {
  const message = incoming(); const queued = await store.ingest(message, 'linq');
  await worker({ async respond() {
    await store.ingest(incoming({ chatId: message.chatId, text: 'STOP' }), 'linq');
    return decision();
  } }).tick();
  assert.equal(sent.length, 0);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'cancelled');
  assert.equal((await store.ingest(incoming({ chatId: message.chatId }), 'linq')).paused, true);
  assert.equal(await worker().tick(), false);
});

test('pause then resume during generation does not resurrect a cancelled turn', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  await worker({ async respond() {
    await store.pause(queued.conversationId!, true);
    await store.pause(queued.conversationId!, false);
    return decision();
  } }).tick();
  assert.equal(sent.length, 0);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'cancelled');
});

test('permanent failures are visible, block later automatic turns, and allow human takeover', async () => {
  const message = incoming(); const queued = await store.ingest(message, 'linq');
  await worker({ async respond() { throw Object.assign(new Error('Invalid key'), { status: 401 }); } }).tick();
  assert.equal((await store.getTurn(queued.turnId!))?.last_error, 'UPSTREAM_401');
  const failed = await request(app).get('/api/turns?status=failed').set(auth).expect(200);
  assert.equal(failed.body.turns[0].id, queued.turnId);
  await store.ingest(incoming({ chatId: message.chatId }), 'linq');
  assert.equal(await worker().tick(), false);
  await store.pause(queued.conversationId!, true);
  const operator = await store.queueOperator(queued.conversationId!, 'A person is here to help.', randomUUID());
  await worker().tick();
  assert.equal((await store.getTurn(operator!.id))?.status, 'done');
  assert.equal(sent[0]?.text, 'A person is here to help.');
});

test('transient failures stop after five attempts and can be explicitly retried', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  const broken: Agent = { async respond() { throw new Error('Network unavailable'); } };
  for (let i = 0; i < 5; i++) { await worker(broken).tick(); await readyAgain(queued.turnId!); }
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'failed');
  await store.retryTurn(queued.turnId!);
  await worker().tick();
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('human escalation creates an actionable task and pauses automation', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  await worker({ async respond() { return decision({ handoff: { kind: 'human', summary: 'Customer requests a person to discuss layout.' } }); } }).tick();
  assert.equal((await store.getConversation(queued.conversationId!))?.paused, true);
  const tasks = await store.listHandoffs();
  assert.equal(tasks[0].kind, 'human');
  await store.completeHandoff(tasks[0].id);
  assert.equal((await store.listHandoffs()).length, 0);
});

test('design handoffs persist the approved brief and can be completed through the API', async () => {
  await store.ingest(incoming(), 'linq');
  const output = decision({ handoff: { kind: 'design', summary: 'Approved cabinet replacement brief.' } });
  Object.assign(output.brief, { propertyAddress: '123 Example Street' });
  await worker({ async respond() { return output; } }).tick();
  const listed = await request(app).get('/api/handoffs').set(auth).expect(200);
  assert.equal(listed.body.handoffs[0].kind, 'design');
  await request(app).patch(`/api/handoffs/${listed.body.handoffs[0].id}`).set(auth).send({ status: 'completed' }).expect(200);
});

test('a generated kitchen image is stored on the assistant message', async () => {
  const photoId = randomUUID();
  await writeSandboxMedia(photoId, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { mimeType: 'image/jpeg', filename: 'kitchen.jpg' });
  const queued = await store.ingest(incoming({
    text: 'Please redesign 123 Example Street.',
    attachments: [{ id: photoId, url: `/api/media/${photoId}`, mimeType: 'image/jpeg', filename: 'kitchen.jpg', sizeBytes: 4 }],
  }), 'sandbox');
  const render: Attachment = { id: randomUUID(), url: `/api/media/${randomUUID()}`, mimeType: 'image/jpeg', filename: 'kitchen-redesign.jpg', sizeBytes: 12 };
  const output = decision({ reply: 'Here is a redesign.', handoff: { kind: 'design', summary: 'First kitchen.' } });
  Object.assign(output.brief, { propertyAddress: '123 Example Street' });
  await worker({ async respond() { return output; } }, messenger, { async generate() { return [render]; } }).tick();
  const history = await store.context(queued.conversationId!);
  const assistant = history?.messages.find((message) => message.role === 'assistant');
  assert.deepEqual(assistant?.attachments, [render]);
  assert.equal((await store.listHandoffs()).length, 0);
});

test('a quiet decision updates the brief without sending a text', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  await worker({ async respond() { return decision({ reply: null }); } }).tick();
  assert.equal(sent.length, 0);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('iMessage reaction targets the latest sender in a burst and is not repeated on a reply retry', async () => {
  const first = incoming();
  const queued = await store.ingest(first, 'linq');
  const last = incoming({ chatId: first.chatId, sender: '+12025550102', text: 'Hi FORM!' });
  await store.ingest(last, 'linq');
  const reactions: string[] = []; let sends = 0; let modelCalls = 0;
  const transport: Messenger = {
    async react(id, emoji) { reactions.push(id); assert.equal(emoji, '👋'); },
    async send() { if (++sends === 1) throw new Error('Ambiguous text delivery'); return 'delivered'; },
  };
  const model: Agent = { async respond(ctx) {
    modelCalls++; assert.equal(ctx.messages.at(-1)?.service, 'iMessage');
    return decision({ reaction: '👋' });
  } };
  await worker(model, transport).tick();
  await readyAgain(queued.turnId!);
  await worker(model, transport).tick();
  assert.deepEqual(reactions, [last.messageId]);
  assert.equal(modelCalls, 1);
  assert.equal(sends, 2);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('a reaction failure cannot block the text reply', async () => {
  const queued = await store.ingest(incoming(), 'linq'); let reactions = 0;
  await worker({ async respond() { return decision({ reaction: '❤️' }); } }, {
    ...messenger, async react() { reactions++; throw Object.assign(new Error('Not supported'), { status: 400 }); },
  }).tick();
  assert.equal(reactions, 1);
  assert.equal(sent.length, 1);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('a reaction can acknowledge a message without sending a text', async () => {
  const message = incoming({ text: 'Thank you!' });
  const queued = await store.ingest(message, 'linq'); const reactions: string[] = [];
  await worker({ async respond() { return decision({ reply: null, reaction: '😊' }); } }, {
    ...messenger, async react(id) { reactions.push(id); },
  }).tick();
  assert.deepEqual(reactions, [message.messageId]);
  assert.equal(sent.length, 0);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('SMS, sandbox conversations, and sandbox mode never send native reactions', async () => {
  const model: Agent = { async respond() { return decision({ reply: null, reaction: '👍' }); } };
  let reactions = 0;
  const transport: Messenger = { ...messenger, async react() { reactions++; } };
  await store.ingest(incoming({ service: 'SMS' }), 'linq');
  await worker(model, transport).tick();
  await store.ingest(incoming(), 'sandbox');
  await worker(model, transport).tick();
  await store.ingest(incoming(), 'linq');
  await new Worker(store, model, transport, logger, 100, 'sandbox').tick();
  assert.equal(reactions, 0);
});

test('STOP during generation cancels reactions, and STOP during a reaction cancels the text', async () => {
  const first = incoming(); const queued = await store.ingest(first, 'linq'); let reactions = 0;
  await worker({ async respond() {
    await store.ingest(incoming({ chatId: first.chatId, text: 'STOP' }), 'linq');
    return decision({ reaction: '👋' });
  } }, { ...messenger, async react() { reactions++; } }).tick();
  assert.equal(reactions, 0);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'cancelled');
  const second = incoming(); const next = await store.ingest(second, 'linq');
  await worker({ async respond() { return decision({ reaction: '👍' }); } }, {
    ...messenger, async react() { await store.ingest(incoming({ chatId: second.chatId, text: 'STOP' }), 'linq'); },
  }).tick();
  assert.equal(sent.length, 0);
  assert.equal((await store.getTurn(next.turnId!))?.status, 'cancelled');
});

test('first-reply context survives the 40-message history limit and resets with a new chat', async () => {
  const message = incoming(); const queued = await store.ingest(message, 'sandbox');
  assert.equal((await store.context(queued.conversationId!))?.hasAssistantReply, false);
  await worker().tick();
  for (let i = 0; i < 41; i++) await store.ingest(incoming({ chatId: message.chatId }), 'sandbox');
  const ctx = await store.context(queued.conversationId!);
  assert.equal(ctx?.messages.length, 40);
  assert.equal(ctx?.messages.some((message) => message.role === 'assistant'), false);
  assert.equal(ctx?.hasAssistantReply, true);
  const fresh = await store.ingest(incoming(), 'sandbox');
  assert.equal((await store.context(fresh.conversationId!))?.hasAssistantReply, false);
  await store.clearConversation(queued.conversationId!);
  assert.equal((await store.context(queued.conversationId!))?.hasAssistantReply, false);
});

test('webhook signatures require the exact body and a recent timestamp; delivery acknowledges before AI work', async () => {
  const body = JSON.stringify(event());
  await request(app).post('/webhooks/linq').type('json').send(body).expect(401);
  await request(app).post('/webhooks/linq').type('json').set(sign(body, Math.floor(Date.now() / 1000) - 600)).send(body).expect(401);
  await request(app).post('/webhooks/linq').type('json').set(sign(body)).send(`${body} `).expect(401);
  const response = await request(app).post('/webhooks/linq?version=2026-02-03').type('json').set(sign(body)).send(body).expect(200);
  assert.ok(response.body.turnId);
  assert.equal(sent.length, 0);
  await worker().tick();
  assert.equal(sent.length, 1);
});

test('valid outbound and wrong-line webhooks cannot trigger replies', async () => {
  const payload = event(); payload.data.direction = 'outbound';
  const body = JSON.stringify(payload);
  assert.equal((await request(app).post('/webhooks/linq').type('json').set(sign(body)).send(body).expect(200)).body.ignored, true);
  const restricted = createApp({ ...config, LINQ_ALLOWED_HANDLES: '+12025550199' }, store);
  const other = JSON.stringify(event());
  assert.equal((await request(restricted).post('/webhooks/linq').type('json').set(sign(other)).send(other).expect(200)).body.ignored, true);
  assert.equal(await worker().tick(), false);
});

test('admin routes require authentication and reject invalid requests', async () => {
  await request(app).get('/healthz').expect(200);
  await request(app).get('/readyz').expect(200);
  await request(app).get('/api/conversations').expect(401);
  await request(app).get('/api/conversations').set('Authorization', 'Bearer wrong').expect(401);
  await request(app).post('/api/sandbox/messages').set(auth).send({ message: '' }).expect(400);
  await request(app).get('/api/conversations/not-a-uuid').set(auth).expect(400);
  await request(app).get(`/api/conversations/${randomUUID()}`).set(auth).expect(404);
  await request(app).post('/api/sandbox/messages').set(auth).type('json').send('{invalid').expect(400);
});

test('sandbox API is idempotent and never sends real texts, even on a live server', async () => {
  const body = { message: 'Please help plan my kitchen', requestId: randomUUID() };
  const first = (await request(app).post('/api/sandbox/messages').set(auth).send(body).expect(202)).body;
  const second = (await request(app).post('/api/sandbox/messages').set(auth).send(body).expect(202)).body;
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.turnId, second.turnId);
  await request(app).post('/api/sandbox/messages').set(auth).send({ ...body, message: 'Conflicting retry' }).expect(409);
  await worker().tick();
  assert.equal(sent.length, 0);
  const turn = (await request(app).get(`/api/turns/${first.turnId}`).set(auth).expect(200)).body.turn;
  assert.equal(turn.status, 'done');
  assert.equal(turn.decision.reply, decision().reply);
});

test('operator messages are idempotent and never invoke the model', async () => {
  const queued = await store.ingest(incoming(), 'sandbox');
  await store.pause(queued.conversationId!, true);
  const path = `/api/conversations/${queued.conversationId}/messages`;
  const body = { text: 'Here is the reviewed design.', requestId: randomUUID() };
  await request(app).post(path).set(auth).send(body).expect(202);
  await request(app).post(path).set(auth).send(body).expect(202);
  await request(app).post(path).set(auth).send({ ...body, text: 'Different content' }).expect(409);
  await worker({ async respond() { throw new Error('Operator replies must not use AI'); } }).tick();
  assert.equal((await store.getTurn(body.requestId))?.status, 'done');
  assert.equal((await store.context(queued.conversationId!))?.messages.at(-1)?.role, 'operator');
  assert.equal(sent.length, 0);
});
