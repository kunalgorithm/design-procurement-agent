import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pino } from 'pino';
import { migrate } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Worker } from '../../src/worker.js';
import { type Agent, type Attachment, type Messenger } from '../../src/domain.js';
import { type DesignStudio } from '../../src/design.js';
import { intakeQuestion } from '../../src/intake.js';
import { decision, incoming, readyBrief } from '../fixtures.js';
import { confirmedDesign, prepareFirstDesign } from './intake-fixtures.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated test database');
const schema = `intake_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const store = new Store(pool, 0);
const sent: { text: string; attachments: Attachment[] }[] = [];
const transport: Messenger = { async send(_chat, text, key, attachments = []) { sent.push({ text, attachments }); return key; } };
const run = (agent: Agent, messenger = transport, studio?: DesignStudio) => new Worker(store, agent, messenger, pino({ level: 'silent' }), 100, 'live', studio).tick();
const render: Attachment = { id: 'render', url: '/unused', filename: 'render.jpg', mimeType: 'image/jpeg', sizeBytes: 4 };
const upload: Attachment = { ...render, id: 'late-photo', filename: 'photo.jpg' };
const ask: Agent = { async respond() { return decision({ brief: readyBrief(), reply: 'More storage and room to cook.', intakeConfirmation: { action: 'ask', messageId: null } }); } };
const generate: Agent = { async respond(ctx) { return confirmedDesign(ctx, decision({ brief: readyBrief(), reply: 'Here is your kitchen.', handoff: { kind: 'design', summary: 'First design' } })); } };

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('TRUNCATE conversations,webhook_events CASCADE'); sent.length = 0; });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('an early design request cannot start rendering or send progress before intake is complete', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  await run({ async respond() { return decision({ brief: { ...readyBrief(), intake: { ...readyBrief().intake!, floorPlan: 'pending' } }, handoff: { kind: 'design', summary: 'Too early' } }); } }, transport,
    { async generate() { assert.fail('Intake is incomplete'); } });
  assert.equal(sent.length, 1); assert.match(sent[0]!.text, /floor plan/);
  assert.equal((await store.context(queued.conversationId!))?.intakeCheckpoint, null);
});

test('a checkpoint is durable only after delivery and survives restart/history truncation', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  await run(ask, { async send() { throw new Error('Network failure'); } });
  assert.equal((await store.context(queued.conversationId!))?.intakeCheckpoint, null);
  await pool.query("UPDATE turns SET lease_until=now()-interval '1 second',available_at=now() WHERE id=$1", [queued.turnId]);
  await run({ async respond() { assert.fail('Retry must use saved question'); } });
  for (let i = 0; i < 45; i++) await pool.query("INSERT INTO messages(conversation_id,role,sender,text) VALUES($1,'user','homeowner','A note')", [queued.conversationId]);
  const restarted = new Store(pool, 0);
  const ctx = (await restarted.context(queued.conversationId!))!;
  assert.equal(ctx.intakeCheckpoint?.id, queued.turnId);
  assert.ok(ctx.intakeCheckpoint?.text.endsWith(intakeQuestion));
  assert.ok(!ctx.messages.some((message) => message.id === queued.turnId));
  assert.equal(ctx.conversation.brief.intake?.floorPlan, 'unavailable');
});

test('a follow-up intake response clears the old checkpoint; a fresh confirmation produces one first design', async () => {
  const message = incoming(); await store.ingest(message, 'linq'); await run(ask);
  await store.ingest(incoming({ chatId: message.chatId, text: 'I have more photos coming.' }), 'linq');
  await run({ async respond(ctx) { return decision({ brief: ctx.conversation.brief, reply: 'Take your time—send them when you’re ready.' }); } });
  const conversation = (await store.listConversations())[0]!;
  assert.equal((await store.context(conversation.id))?.intakeCheckpoint, null);
  await store.ingest(incoming({ chatId: message.chatId, text: 'That is all of the photos.', attachments: [upload] }), 'linq');
  await run(ask);
  assert.equal(sent.some((message) => message.attachments.length), false);
  await store.ingest(incoming({ chatId: message.chatId, text: 'Nothing else, go ahead.' }), 'linq');
  let calls = 0; await run(generate, transport, { async generate() { calls++; return [render]; } });
  assert.equal(calls, 1); assert.equal(sent.filter((message) => message.attachments.length).length, 1);
  assert.equal((await store.context(conversation.id))?.designCount, 1);
  assert.equal((await store.context(conversation.id))?.intakeCheckpoint, null);
});

for (const stage of ['model', 'progress', 'render'] as const) {
  test(`a new upload during ${stage} processing defers the first design and retains all input`, async () => {
    const message = incoming(); const queued = await prepareFirstDesign(store, message, 'linq');
    let calls = 0;
    const more = () => store.ingest(incoming({ chatId: message.chatId, text: 'One more picture, wait.', attachments: [upload] }), 'linq');
    const model: Agent = { async respond(ctx) { if (stage === 'model') await more(); return generate.respond(ctx); } };
    const messenger: Messenger = { async send(chat, text, key, files) { if (stage === 'progress') await more(); return transport.send(chat, text, key, files); } };
    const studio: DesignStudio = { async generate() { calls++; if (stage === 'render') await more(); return [render]; } };
    await run(model, messenger, studio);
    assert.equal(calls, stage === 'render' ? 1 : 0);
    assert.equal((await store.getTurn(queued.turnId!))?.status, 'cancelled');
    assert.equal(sent.some((message) => message.attachments.length), false);
    const ctx = (await store.context(queued.conversationId!))!;
    assert.equal(ctx.designCount, 0);
    assert.ok(ctx.messages.some((message) => message.attachments.some((file) => file.id === upload.id)));
    await run(ask);
    assert.ok(sent.at(-1)!.text.endsWith(intakeQuestion));
  });
}

test('legacy saved first-design decisions cannot bypass the new gate or deliver cached images', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  await pool.query("UPDATE turns SET decision=$2,generated_attachments=$3 WHERE id=$1", [queued.turnId,
    JSON.stringify(decision({ brief: readyBrief(), handoff: { kind: 'design', summary: 'Pre-checkpoint legacy turn' } })), JSON.stringify([render])]);
  await run({ async respond() { assert.fail('Saved turn'); } }, transport, { async generate() { assert.fail('Needs a checkpoint'); } });
  assert.equal(sent.length, 1); assert.ok(sent[0]!.text.endsWith(intakeQuestion));
  assert.equal(sent[0]!.attachments.length, 0);
  assert.equal((await store.context(queued.conversationId!))?.designCount, 0);
});
