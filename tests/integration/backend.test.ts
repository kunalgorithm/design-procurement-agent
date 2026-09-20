import { prepareFirstDesign, confirmedDesign } from './intake-fixtures.js';
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
import { designReview, type Agent, type AgentContext, type Attachment, type Messenger } from '../../src/domain.js';
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

const finalizeAgent: Agent = { async respond(ctx) {
  return decision({ reply: 'Your design is finalized. Your choices are saved for your contractor.', brief: ctx.conversation.brief,
    handoff: { kind: 'finalization', summary: 'Customer approved dark cabinets and the existing backsplash.' },
    approval: { designAttachmentId: designReview(ctx).attachment!.id, customerMessageId: ctx.messages.findLast((message) => message.role === 'user')!.id } });
} };
async function deliveredDesign() {
  const chatId = randomUUID();
  const queued = await prepareFirstDesign(store, incoming({ chatId, isGroup: false, text: '123 Example St. Dark cabinets, keep the backsplash.' }), 'linq');
  const id = randomUUID();
  const render: Attachment = { id, url: `/api/media/${id}`, mimeType: 'image/jpeg', filename: 'kitchen-design.jpg', sizeBytes: 4 };
  await worker({ async respond(ctx) { return confirmedDesign(ctx, decision({ reply: null,
    brief: { ...decision().brief, propertyAddress: '123 Example St', materials: ['Dark cabinets', 'Existing backsplash'] },
    handoff: { kind: 'design', summary: 'First design' } })); } }, messenger, { async generate() { return [render]; } }).tick();
  return { chatId, conversationId: queued.conversationId!, render };
}

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('TRUNCATE conversations,webhook_events CASCADE'); sent.length = 0; });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('migrations are repeatable', async () => {
  await migrate(pool);
  assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '9');
});

test('finalization saves the exact image, customer evidence and choices once across a delivery retry', async () => {
  const { chatId, conversationId, render } = await deliveredDesign();
  assert.match(sent.at(-1)!.text, /What do you think/);
  // Simulate a delayed approval webhook for a design delivered an hour earlier.
  await pool.query("UPDATE messages SET created_at=now()-interval '1 hour' WHERE conversation_id=$1 AND role='assistant'", [conversationId]);
  const sentAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const approved = await store.ingest(incoming({ chatId, isGroup: false, text: 'This is the one. Finalize it.', sentAt }), 'linq');
  await worker(finalizeAgent, { async send() { throw new Error('connection lost'); } }).tick();
  assert.equal((await store.listHandoffs()).length, 0);
  await readyAgain(approved.turnId!);
  await worker({ async respond() { throw new Error('Must reuse saved decision'); } }).tick();
  const task = (await store.listHandoffs())[0]!;
  assert.equal(task.kind, 'finalization');
  assert.deepEqual(task.design_approval.design, render);
  assert.equal(task.design_approval.customerText, 'This is the one. Finalize it.');
  assert.equal(task.design_approval.approvedAt, sentAt);
  assert.deepEqual(task.design_approval.brief.materials, ['Dark cabinets', 'Existing backsplash']);
  assert.equal(task.design_approval.brief.contractorName, null);
  assert.equal((await store.getConversation(conversationId))?.paused, false);
  assert.equal(await worker().tick(), false);
  const recorded = await store.getTurn(approved.turnId!);
  await store.finish(recorded!, recorded!.decision!, 'retry');
  assert.equal((await store.listHandoffs()).length, 1);
  // Operator completion and process restarts do not restart the approval conversation.
  await request(app).patch(`/api/handoffs/${task.id}`).set(auth).send({ status: 'completed' }).expect(200);
  const restarted = new Store(pool, 0);
  assert.equal(designReview((await restarted.context(conversationId))!).finalized?.status, 'completed');
  await store.ingest(incoming({ chatId, isGroup: false, text: 'Finalize it.' }), 'linq');
  await worker(finalizeAgent).tick();
  assert.equal((await pool.query("SELECT count(*) FROM handoffs WHERE kind='finalization'")).rows[0].count, '1');
});

for (const stage of ['model', 'delivery'] as const) test(`a late revision during ${stage} prevents a stale contractor handoff even if the next model request fails`, async () => {
  const { chatId, conversationId } = await deliveredDesign();
  const queued = await store.ingest(incoming({ chatId, isGroup: false, text: 'Finalize this.' }), 'linq');
  const messagesBefore = sent.length;
  const retract = () => store.ingest(incoming({ chatId, isGroup: false, text: 'Wait, make the cabinets white.' }), 'linq');
  await worker({ async respond(ctx) {
    if (stage === 'model') await retract();
    return finalizeAgent.respond(ctx);
  } }, { async send(chat, text, key) {
    if (stage === 'delivery') await retract();
    return messenger.send(chat, text, key);
  } }).tick();
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'cancelled');
  assert.equal((await store.listHandoffs()).length, 0);
  assert.equal(sent.length - messagesBefore, stage === 'model' ? 0 : 1);
  assert.equal((await store.context(conversationId))?.finalizedDesign, null);
  await worker({ async respond() { throw new Error('model temporarily unavailable'); } }).tick();
  assert.equal((await store.listHandoffs()).length, 0);
  assert.equal((await pool.query("SELECT count(*) FROM handoffs WHERE kind='finalization'")).rows[0].count, '0');
});

test('a revision withdraws prior finalization before generation and requires approval of the new image', async () => {
  const { chatId, conversationId } = await deliveredDesign();
  await store.ingest(incoming({ chatId, isGroup: false, text: 'Finalize this.' }), 'linq');
  await worker(finalizeAgent).tick();
  const old = (await store.listHandoffs())[0]!;
  await store.ingest(incoming({ chatId, isGroup: false, text: 'Actually, make the cabinets white.' }), 'linq');
  const nextImage: Attachment = { id: randomUUID(), url: '/api/media/new-image', mimeType: 'image/jpeg', filename: 'white-cabinets.jpg', sizeBytes: 4 };
  await worker({ async respond(ctx) { return decision({ reply: null, brief: { ...ctx.conversation.brief, materials: ['White cabinets', 'Existing backsplash'] }, handoff: { kind: 'design', summary: 'White cabinets' } }); } }, messenger, {
    async generate() {
      assert.equal((await store.listHandoffs()).length, 0);
      assert.equal((await store.context(conversationId))!.finalizedDesign, null);
      assert.equal(await store.completeHandoff(old.id), undefined);
      return [nextImage];
    },
  }).tick();
  assert.match(sent.at(-1)!.text, /Would you like to finalize/);
  assert.equal(designReview((await store.context(conversationId))!).count, 2);
  await store.ingest(incoming({ chatId, isGroup: false, text: 'Yes, finalize this version.' }), 'linq');
  await worker(finalizeAgent).tick();
  const tasks = await store.listHandoffs(); assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.design_approval.design.id, nextImage.id);
  assert.deepEqual(tasks[0]!.design_approval.brief.materials, ['White cabinets', 'Existing backsplash']);
  assert.equal((await pool.query('SELECT status FROM handoffs WHERE id=$1', [old.id])).rows[0].status, 'superseded');
});

test('design-review state survives the history window and reset starts without a finalized project', async () => {
  const { chatId, conversationId } = await deliveredDesign();
  await store.ingest(incoming({ chatId, isGroup: false, text: 'I’m the homeowner. Finalize this.' }), 'linq');
  await worker(finalizeAgent).tick();
  await pool.query("INSERT INTO messages(conversation_id,role,sender,text) SELECT $1,'user','homeowner','Thanks' FROM generate_series(1,45)", [conversationId]);
  // Unrelated completed work can also push the approval out of the handoff window.
  for (let i = 0; i < 31; i++) {
    const turn = (await pool.query("INSERT INTO turns(conversation_id,through_seq,status) VALUES($1,0,'done') RETURNING id", [conversationId])).rows[0];
    await pool.query("INSERT INTO handoffs(conversation_id,turn_id,kind,summary,status) VALUES($1,$2,'proposal','Historical task','completed')", [conversationId,turn.id]);
  }
  const ctx = (await new Store(pool, 0).context(conversationId))!;
  assert.equal(ctx.messages.length, 40);
  assert.equal(ctx.conversation.participant_roles?.['+12025550101'], 'homeowner');
  assert.equal(ctx.handoffs.some((task) => task.kind === 'finalization'), false);
  assert.equal(designReview(ctx).count, 1); assert.ok(designReview(ctx).finalized);
  const fresh = await store.ingest(incoming({ chatId, isGroup: false, text: '/new' }), 'linq', true);
  const reset = (await store.context(fresh.conversationId!))!;
  assert.equal(designReview(reset).count, 0); assert.equal(designReview(reset).finalized, null);
  assert.deepEqual(reset.conversation.participant_roles, {});
  assert.equal((await store.listHandoffs()).length, 0);
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
  assert.equal(sent.length, 1, 'Defer stale intake replies until the latest input is included');
  assert.equal((await store.getTurn(first.turnId!))?.status, 'cancelled');
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

test('permanent failures are visible, notify the user, and do not block later requests', async () => {
  const message = incoming(); const queued = await store.ingest(message, 'linq');
  await worker({ async respond() { throw Object.assign(new Error('Invalid key'), { status: 401 }); } }).tick();
  assert.equal((await store.getTurn(queued.turnId!))?.last_error, 'UPSTREAM_401');
  const failed = await request(app).get('/api/turns?status=failed').set(auth).expect(200);
  assert.equal(failed.body.turns[0].id, queued.turnId);
  await worker().tick();
  assert.match(sent[0]!.text, /couldn’t finish/);
  assert.doesNotMatch(sent[0]!.text, /ask for a person/i);
  await store.ingest(incoming({ chatId: message.chatId }), 'linq');
  assert.equal(await worker().tick(), true);
  await store.pause(queued.conversationId!, true);
  const operator = await store.queueOperator(queued.conversationId!, 'A person is here to help.', randomUUID());
  await worker().tick();
  assert.equal((await store.getTurn(operator!.id))?.status, 'done');
  assert.equal(sent.at(-1)?.text, 'A person is here to help.');
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
  await prepareFirstDesign(store, incoming(), 'linq');
  const output = decision({ handoff: { kind: 'design', summary: 'Approved cabinet replacement brief.' } });
  Object.assign(output.brief, { propertyAddress: '123 Example Street' });
  await worker({ async respond(ctx) { return confirmedDesign(ctx, output); } }).tick();
  const listed = await request(app).get('/api/handoffs').set(auth).expect(200);
  assert.equal(listed.body.handoffs[0].kind, 'design');
  await request(app).patch(`/api/handoffs/${listed.body.handoffs[0].id}`).set(auth).send({ status: 'completed' }).expect(200);
});

test('a generated kitchen image is stored on the assistant message', async () => {
  const photoId = randomUUID();
  await writeSandboxMedia(photoId, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { mimeType: 'image/jpeg', filename: 'kitchen.jpg' });
  const queued = await prepareFirstDesign(store, incoming({
    text: 'Please redesign 123 Example Street.',
    attachments: [{ id: photoId, url: `/api/media/${photoId}`, mimeType: 'image/jpeg', filename: 'kitchen.jpg', sizeBytes: 4 }],
  }), 'sandbox');
  const render: Attachment = { id: randomUUID(), url: `/api/media/${randomUUID()}`, mimeType: 'image/jpeg', filename: 'kitchen-redesign.jpg', sizeBytes: 12 };
  const output = decision({ reply: 'Here is a redesign.', handoff: { kind: 'design', summary: 'First kitchen.' } });
  Object.assign(output.brief, { propertyAddress: '123 Example Street' });
  await worker({ async respond(ctx) { return confirmedDesign(ctx, output); } }, messenger, { async generate() { return [render]; } }).tick();
  const history = await store.context(queued.conversationId!);
  const assistant = history?.messages.findLast((message) => message.role === 'assistant');
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

test('progress precedes rendering and failed delivery reuses the saved image and message key', async () => {
  const queued = await prepareFirstDesign(store, incoming(), 'linq');
  const render: Attachment = { id: randomUUID(), url: '/unused-test-reference', mimeType: 'image/jpeg', filename: 'design.jpg', sizeBytes: 4 };
  const output = decision({ reply: 'Here is the revised kitchen.', handoff: { kind: 'design', summary: 'Lighter cabinets' }, brief: { ...decision().brief, propertyAddress: '123 Example St' } });
  let models = 0; let renders = 0;
  const deliveries: { key: string; text: string; attachments: Attachment[] }[] = [];
  const model: Agent = { async respond(ctx) { models++; return confirmedDesign(ctx, output); } };
  const transport: Messenger = { async send(_chat, text, key, attachments = []) {
    deliveries.push({ key, text, attachments });
    if (attachments.length && deliveries.filter((entry) => entry.attachments.length).length === 1) throw new Error('Lost acknowledgement');
    return `sent-${key}`;
  } };
  const design: DesignStudio = { async generate() {
    renders++;
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0]!.text, /working on your kitchen/);
    return [render];
  } };
  await worker(model, transport, design).tick();
  assert.deepEqual((await store.getTurn(queued.turnId!))?.generated_attachments, [render]);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'processing');
  assert.equal((await store.context(queued.conversationId!))?.handoffs.length, 0);
  await readyAgain(queued.turnId!);
  await worker(model, transport, design).tick();
  assert.equal(models, 1); assert.equal(renders, 1);
  assert.equal(deliveries.length, 3);
  assert.deepEqual(deliveries[1], deliveries[2]);
  assert.equal(deliveries[1]!.key, queued.turnId);
  const ctx = await store.context(queued.conversationId!);
  assert.equal(ctx?.handoffs[0]?.status, 'completed');
  assert.deepEqual(ctx?.messages.at(-1)?.attachments, [render]);
});

test('image-model access failure preserves the request and reports unavailability without a retry loop or human offer', async () => {
  const queued = await prepareFirstDesign(store, incoming(), 'linq');
  const output = decision({ reply: 'Here is your kitchen.', handoff: { kind: 'design', summary: 'Render kitchen' },
    brief: { ...decision().brief, propertyAddress: '123 Example St' } });
  let renders = 0;
  const runner = worker({ async respond(ctx) { return confirmedDesign(ctx, output); } }, messenger, { async generate() {
    renders++;
    throw Object.assign(new Error('Project does not have access to image model'), { status: 403, code: 'model_not_found' });
  } });
  await runner.tick();
  const turn = await store.getTurn(queued.turnId!);
  assert.equal(turn?.status, 'failed');
  assert.equal(turn?.last_error, 'IMAGE_GENERATION_UNAVAILABLE');
  assert.equal(turn?.decision?.brief.propertyAddress, '123 Example St');
  await runner.tick();
  assert.equal(await runner.tick(), false);
  assert.equal(renders, 1);
  assert.equal(sent.at(-1)?.text, 'Image generation is temporarily unavailable. Your photos and request are saved.');
  assert.equal((await store.getConversation(queued.conversationId!))?.paused, false);
  assert.equal((await store.context(queued.conversationId!))?.handoffs.length, 0);
});

test('one running worker serves a second chat while the first chat is rendering', async () => {
  const first = incoming(); await prepareFirstDesign(store, first, 'sandbox');
  let release!: () => void; let entered!: () => void; let answered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const secondAnswered = new Promise<void>((resolve) => { answered = resolve; });
  const model: Agent = { async respond(ctx) {
    if (ctx.conversation.external_id !== first.chatId) { answered(); return decision(); }
    return confirmedDesign(ctx, decision({ handoff: { kind: 'design', summary: 'Kitchen' }, brief: { ...decision().brief, propertyAddress: '123 Example St' } }));
  } };
  const design: DesignStudio = { async generate() { entered(); await gate; return []; } };
  const runner = new Worker(store, model, messenger, logger, 20, 'sandbox', design, 2);
  runner.start();
  const deadline = (promise: Promise<void>) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Worker did not make progress')), 3000).unref())]);
  try {
    await deadline(started);
    await store.ingest(incoming({ chatId: first.chatId, text: 'Keep the floor' }), 'sandbox');
    await store.ingest(incoming(), 'sandbox');
    await deadline(secondAnswered);
  } finally { release(); await runner.stop(); }
});

test('STOP during a progress update prevents image generation and the final reply', async () => {
  const message = incoming(); const queued = await prepareFirstDesign(store, message, 'linq');
  let renders = 0;
  await worker({ async respond(ctx) { return confirmedDesign(ctx, decision({ handoff: { kind: 'design', summary: 'Kitchen' }, brief: { ...decision().brief, propertyAddress: '123 Example St' } })); } }, {
    async send() { await store.ingest(incoming({ chatId: message.chatId, text: 'STOP' }), 'linq'); return 'progress-accepted'; },
  }, { async generate() { renders++; return []; } }).tick();
  assert.equal(renders, 0);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'cancelled');
});

test('failure updates retry with a stable key and stop after a newer request succeeds', async () => {
  const message = incoming(); const queued = await store.ingest(message, 'linq');
  await worker({ async respond() { throw Object.assign(new Error('Unavailable'), { status: 400 }); } }).tick();
  const keys: string[] = [];
  const transport: Messenger = { async send(_chat, _text, key) { keys.push(key); throw new Error('Ambiguous update delivery'); } };
  await worker(agent, transport).tick();
  await readyAgain(queued.turnId!);
  await worker(agent, transport).tick();
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  const next = await store.ingest(incoming({ chatId: message.chatId, text: 'A new question' }), 'linq');
  await worker().tick();
  assert.equal((await store.getTurn(next.turnId!))?.status, 'done');
  await readyAgain(queued.turnId!);
  await worker(agent, transport).tick();
  assert.equal(keys.length, 2);
  assert.ok((await store.getTurn(queued.turnId!))?.failure_notified_at);
  assert.equal(await store.retryTurn(queued.turnId!), undefined, 'Do not replay obsolete decisions over a newer completed turn');
});

test('missing reference images produce a recovery reply without a completed design', async () => {
  const queued = await prepareFirstDesign(store, incoming(), 'sandbox');
  await worker({ async respond(ctx) { return confirmedDesign(ctx, decision({ reply: 'Here is your design', handoff: { kind: 'design', summary: 'Kitchen' }, brief: { ...decision().brief, propertyAddress: '123 Example St' } })); } }, messenger,
    { async generate() { throw new Error('REFERENCE_IMAGES_UNAVAILABLE'); } }).tick();
  const ctx = await store.context(queued.conversationId!);
  assert.match(ctx?.messages.at(-1)?.text ?? '', /send a JPEG or PNG/);
  assert.equal(ctx?.handoffs.length, 0);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('a plain try-again message resends the saved design without another model or image call', async () => {
  const message = incoming(); const queued = await prepareFirstDesign(store, message, 'linq');
  const render: Attachment = { id: randomUUID(), url: '/unused-test-reference', mimeType: 'image/jpeg', filename: 'design.jpg', sizeBytes: 4 };
  let models = 0; let renders = 0; let failDelivery = true;
  const deliveries: { key: string; attachments: Attachment[] }[] = [];
  const model: Agent = { async respond(ctx) { models++; return confirmedDesign(ctx, decision({ reply: 'Here is your design.', handoff: { kind: 'design', summary: 'Kitchen' }, brief: { ...decision().brief, propertyAddress: '123 Example St' } })); } };
  const transport: Messenger = { async send(_chat, _text, key, attachments = []) {
    deliveries.push({ key, attachments });
    if (attachments.length && failDelivery) throw Object.assign(new Error('Delivery rejected'), { status: 400 });
    return `sent-${key}`;
  } };
  const studio: DesignStudio = { async generate() { renders++; return [render]; } };
  await worker(model, transport, studio).tick();
  await worker(model, transport, studio).tick();
  assert.match((await store.context(queued.conversationId!))?.messages.at(-1)?.text ?? '', /Reply ‘try again’ to resend/);
  const retryMessage = incoming({ chatId: message.chatId, text: 'try again' });
  const retry = await store.ingest(retryMessage, 'linq');
  assert.equal(retry.turnId, queued.turnId);
  assert.equal((await store.ingest(retryMessage, 'linq')).turnId, queued.turnId);
  failDelivery = false;
  await worker(model, transport, studio).tick();
  assert.equal(models, 1); assert.equal(renders, 1);
  assert.deepEqual(deliveries.filter((item) => item.attachments.length), [
    { key: queued.turnId!, attachments: [render] }, { key: queued.turnId!, attachments: [render] },
  ]);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
  const newRequest = await store.ingest(incoming({ chatId: message.chatId, text: 'try again, but use green cabinets' }), 'linq');
  assert.notEqual(newRequest.turnId, queued.turnId);
});

test('a retry after another failure gets a fresh failure notice and cannot revive older work', async () => {
  const message = incoming(); const queued = await store.ingest(message, 'sandbox');
  const unavailable: Agent = { async respond() { throw Object.assign(new Error('Unavailable'), { status: 400 }); } };
  await worker(unavailable).tick();
  await worker(unavailable).tick();
  await store.ingest(incoming({ chatId: message.chatId, text: 'please try again' }), 'sandbox');
  await worker(unavailable).tick();
  await worker(unavailable).tick();
  const notices = (await store.context(queued.conversationId!))?.messages.filter((item) => item.role === 'assistant') ?? [];
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0]!.id, notices[1]!.id);
  const newer = await store.ingest(incoming({ chatId: message.chatId, text: 'A different question' }), 'sandbox');
  await worker().tick();
  const next = await store.ingest(incoming({ chatId: message.chatId, text: 'try again' }), 'sandbox');
  assert.notEqual(next.turnId, queued.turnId);
  assert.notEqual(next.turnId, newer.turnId);
  assert.equal(await store.retryTurn(queued.turnId!), undefined);
});

test('generated image bytes and the current design remain available beyond the recent message window', async () => {
  const queued = await prepareFirstDesign(store, incoming(), 'sandbox');
  const id = randomUUID(); const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const render: Attachment = { id, url: `/api/media/${id}`, mimeType: 'image/jpeg', filename: 'design.jpg', sizeBytes: bytes.length };
  await store.saveMedia(queued.conversationId!, render, bytes);
  await worker({ async respond(ctx) { return confirmedDesign(ctx, decision({ handoff: { kind: 'design', summary: 'Kitchen' }, brief: { ...decision().brief, propertyAddress: '123 Example St' } })); } }, messenger, { async generate() { return [render]; } }).tick();
  for (let i = 0; i < 45; i++) await pool.query("INSERT INTO messages(conversation_id,role,sender,text) VALUES($1,'user','homeowner','More notes')", [queued.conversationId]);
  const ctx = await store.context(queued.conversationId!);
  assert.equal(ctx?.messages.length, 40);
  assert.ok(ctx?.referenceMessages?.some((message) => message.attachments.some((item) => item.id === id)));
  const media = await request(app).get(`/api/media/${id}`).set(auth).expect(200);
  assert.deepEqual(media.body, bytes);
  await request(app).get(`/api/media/${id}`).expect(401);
  await store.saveProviderAttachment(id, 'linq-upload');
  assert.equal(await store.providerAttachment(id), 'linq-upload');
  await store.clearConversation(queued.conversationId!);
  assert.equal(await store.readMedia(id), null);
});
