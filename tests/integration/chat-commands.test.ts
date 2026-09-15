import { prepareFirstDesign, confirmedDesign } from './intake-fixtures.js';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import request from 'supertest';
import { pino } from 'pino';
import { migrate } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Worker } from '../../src/worker.js';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { identifiedSenderRole, participantContext, type Agent, type Attachment, type Messenger } from '../../src/domain.js';
import type { DesignStudio } from '../../src/design.js';
import { incoming, decision, event, sign, webhookSecret } from '../fixtures.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated test database');
const schema = `commands_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const store = new Store(pool, 0);
const kunal = '+12025550101'; const danny = '+12025550102';
const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32', OPENAI_API_KEY: 'test',
  MESSAGING_MODE: 'live', LINQ_API_KEY: 'test', LINQ_WEBHOOK_SECRET: webhookSecret, LINQ_ADMIN_NUMBERS: `${kunal},${danny}` });
const app = createApp(config, store);
const auth = { Authorization: `Bearer ${config.ADMIN_API_KEY}` };
const sent: { chat: string; text: string; key: string; attachments: Attachment[] }[] = [];
const messenger: Messenger = { async send(chat, text, key, attachments = []) { sent.push({ chat,text,key,attachments }); return `sent-${key}`; } };
const noModel: Agent = { async respond() { assert.fail('Admin commands must not invoke the model'); } };
const worker = (agent = noModel, transport = messenger, studio?: DesignStudio) => new Worker(store, agent, transport, pino({ level: 'silent' }), 100, 'live', studio);
function commandEvent(text: string, sender = kunal, chat: string = randomUUID(), group = true) {
  const payload = event();
  payload.data.sender_handle.handle = sender; payload.data.chat.id = chat; payload.data.chat.is_group = group;
  payload.data.parts = [{ type: 'text', value: text }];
  return payload;
}
async function deliver(payload: ReturnType<typeof event>, server = app) {
  const body = JSON.stringify(payload);
  return (await request(server).post('/webhooks/linq').type('json').set(sign(body)).send(body).expect(200)).body;
}
const command = (text: string, sender = kunal, chat: string = randomUUID(), group = true) => deliver(commandEvent(text,sender,chat,group));

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('TRUNCATE conversations,contractor_signups,webhook_events CASCADE'); sent.length = 0; });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('private role sessions survive restart, leave signup and other chats unchanged, and /new restores recognition', async () => {
  await store.registerContractor({ submissionId: randomUUID(), firstName: 'Sam', lastName: 'Rivera', phone: kunal,
    email: 'sam@example.com', businessName: 'Example Kitchens' }, '+12025550100');
  const before = (await pool.query('SELECT * FROM contractor_signups')).rows;
  const other = await store.ingest(incoming({ isGroup: false, text: 'Another client project' }), 'linq');
  const group = await store.ingest(incoming({ text: 'A group project' }), 'linq');
  await store.pause(other.conversationId!, true); await store.pause(group.conversationId!, true);
  const chat = randomUUID();
  for (const [name, role] of [['/client', 'homeowner'], ['/contractor', 'contractor']] as const) {
    const payload = commandEvent(name, '+1 (202) 555-0101', chat, false);
    const receipts = await Promise.all([deliver(payload), deliver(payload), deliver(payload)]);
    const id = receipts[0].conversationId;
    assert.ok(receipts.every((receipt) => receipt.conversationId === id && receipt.turnId === receipts[0].turnId));
    await worker().tick();
    assert.match(sent.at(-1)!.text, /fresh project/);
    await store.syncChatParticipants(id, { handles: [kunal], owner: '+12025550100', isGroup: false });
    const next = await store.ingest(incoming({ chatId: chat, isGroup: false, text: 'Hi' }), 'linq');
    assert.equal(next.conversationId, id);
    const restarted = (await new Store(pool).context(id))!;
    assert.equal(identifiedSenderRole(restarted, kunal), role);
    assert.equal(restarted.conversation.role_override_sender, kunal);
    assert.equal(restarted.hasAssistantReply, false);
    assert.deepEqual(restarted.messages.map((message) => message.text), ['Hi']);
    if (role === 'homeowner') {
      assert.equal(restarted.registeredContractors?.length, 0);
      assert.equal(restarted.conversation.contractor_signup_id, null);
      assert.doesNotMatch(participantContext(restarted), /Sam|Example Kitchens/);
      assert.match(participantContext(restarted), /Introduce yourself in your first text reply/);
    } else {
      assert.equal(restarted.registeredContractors?.[0]?.firstName, 'Sam');
      assert.match(participantContext(restarted), /Do not introduce yourself to the contractor/);
    }
    await store.pause(id, true);
    await command('/status', kunal, chat, false); await worker().tick();
    assert.match(sent.at(-1)!.text, new RegExp(`Your role: ${name.slice(1)} \\(selected for this project\\)`));
    assert.equal(identifiedSenderRole((await store.context(other.conversationId!))!, kunal), 'contractor');
    assert.equal(identifiedSenderRole((await store.context(group.conversationId!))!, kunal), 'contractor');
  }
  const reset = await command('/new', kunal, chat, false); await worker().tick();
  assert.match(sent.at(-1)!.text, /usual role is restored/);
  const restored = (await new Store(pool).context(reset.conversationId))!;
  assert.equal(restored.conversation.role_override, null);
  assert.equal(restored.conversation.role_override_sender, null);
  assert.equal(identifiedSenderRole(restored, kunal), 'contractor');
  assert.deepEqual((await pool.query('SELECT * FROM contractor_signups')).rows, before);
});

test('both admins can select a private contractor role without a signup', async () => {
  for (const sender of [kunal, danny]) {
    const chat = randomUUID();
    const result = await command('/contractor', sender, chat, false); await worker().tick();
    await store.ingest(incoming({ sender, chatId: chat, isGroup: false, text: 'Hi' }), 'linq');
    const ctx = (await store.context(result.conversationId))!;
    assert.equal(identifiedSenderRole(ctx, sender), 'contractor');
    assert.equal(ctx.registeredContractors?.length, 0);
    assert.match(participantContext(ctx), /Do not introduce yourself to the contractor/);
    assert.doesNotMatch(participantContext(ctx), /Introduce yourself in your first text reply/);
    await store.pause(result.conversationId, true);
  }
});

test('role switches reject groups using both stored and incoming group state', async () => {
  for (const [storedGroup, incomingGroup] of [[true, true], [true, false], [false, true]]) {
    const chat = randomUUID();
    const original = await store.ingest(incoming({ chatId: chat, isGroup: storedGroup }), 'linq');
    await store.pause(original.conversationId!, true);
    for (const name of ['/client', '/contractor']) {
      const result = await command(name, kunal, chat, incomingGroup);
      assert.equal(result.conversationId, original.conversationId);
      await worker().tick();
      assert.match(sent.at(-1)!.text, /private chat/);
      assert.equal((await store.getConversation(result.conversationId))?.role_override, null);
      assert.equal((await store.getConversation(result.conversationId))?.paused, true);
    }
  }
  assert.equal((await store.listConversations(true)).length, 0);
});

test('role commands require sender authorization and no attachments in a private chat', async () => {
  for (const name of ['/client', '/contractor']) {
    for (const allowed of [true, false]) {
      const payload = commandEvent(name, allowed ? kunal : '+12025550199', randomUUID(), false);
      if (allowed) payload.data.parts.push({ type: 'media', id: 'photo', url: 'https://cdn.linqapp.com/photo.jpg', mime_type: 'image/jpeg' });
      const result = await deliver(payload); await worker().tick();
      assert.match(sent.at(-1)!.text, allowed ? /without attachments/ : /only to FORM admins/);
      assert.equal((await store.getConversation(result.conversationId))?.role_override, null);
    }
  }
  assert.equal((await store.listConversations(true)).length, 0);
});

test('both configured admins can pause and resume group and direct chats without a model call', async () => {
  for (const [sender,group] of [[kunal,true],[danny,false]] as const) {
    const chat = randomUUID();
    const pending = await store.ingest(incoming({ chatId: chat, isGroup: group }), 'linq');
    const paused = await command('/pause',sender,chat,group);
    assert.equal(paused.authorized, true); assert.equal(paused.paused, true);
    assert.equal((await store.getTurn(pending.turnId!))?.status, 'cancelled');
    await worker().tick();
    assert.match(sent.at(-1)!.text, /paused/); assert.equal(sent.at(-1)!.chat, chat);
    const ignored = await store.ingest(incoming({ chatId: chat, text: 'Notes while paused' }), 'linq');
    assert.equal(ignored.paused, true); assert.equal(ignored.turnId, undefined);
    const resumed = await command('/resume',sender,chat,group);
    await worker().tick();
    assert.equal(resumed.paused, false); assert.match(sent.at(-1)!.text, /active/);
    assert.equal(await worker().tick(), false, 'Resume must not replay cancelled work');
    assert.equal((await store.context(paused.conversationId))?.hasAssistantReply, false);
  }
});

test('unlisted senders cannot reset, pause, resume, or inspect status, even if the owned line is an admin', async () => {
  const chat = randomUUID();
  const original = await store.ingest(incoming({ chatId: chat }), 'linq');
  await worker({ async respond() { return decision(); } }).tick();
  await command('/pause','+12025550199',chat);
  await worker().tick();
  assert.equal((await store.getConversation(original.conversationId!))?.paused, false);
  await store.pause(original.conversationId!, true);
  for (const text of ['/reset','/new','/pause','/resume','/status','/contractor','/client']) {
    const payload = commandEvent(text, '+12025550199', chat);
    payload.data.chat.owner_handle.handle = kunal;
    const result = await deliver(payload);
    assert.equal(result.authorized, false); assert.equal(result.conversationId, original.conversationId);
    await worker().tick();
    assert.equal(sent.at(-1)!.text, 'That command is available only to FORM admins.');
  }
  assert.equal((await store.listConversations()).length, 1);
  assert.equal((await store.listConversations(true)).length, 0);
  assert.equal((await store.getConversation(original.conversationId!))?.paused, true);
  const ctx = await store.context(original.conversationId!);
  assert.equal(ctx?.messages.length, 2); assert.equal(ctx?.hasAssistantReply, true);
});

test('commands require a valid signed webhook and configured sender, including formatted phone handles', async () => {
  const payload = commandEvent('/pause', '+1 (202) 555-0102');
  await request(app).post('/webhooks/linq').type('json').send(JSON.stringify(payload)).expect(401);
  assert.equal((await store.listConversations()).length, 0);
  assert.equal((await deliver(payload)).authorized, true);
  await worker().tick();
  const disabled = createApp({ ...config, LINQ_ADMIN_NUMBERS: [] }, store);
  assert.equal((await deliver(commandEvent('/resume',danny,payload.data.chat.id), disabled)).authorized, false);
  await worker().tick();
  assert.equal((await store.listConversations())[0]?.paused, true);
});

test('reset and role commands archive the full old session and route later messages to fresh context', async () => {
  for (const name of ['/reset','/new','/client','/contractor']) {
    const group = name === '/reset' || name === '/new';
    const chat = randomUUID();
    const original = await prepareFirstDesign(store, incoming({ chatId: chat, isGroup: group, text: '123 Example St, use oak' }), 'linq');
    const render: Attachment = { id: randomUUID(), url: '/unused-test-image', mimeType: 'image/jpeg', filename: 'design.jpg', sizeBytes: 4 };
    const brief = { ...decision().brief, propertyAddress: '123 Example St', style: 'Oak' };
    await worker({ async respond(ctx) { return confirmedDesign(ctx, decision({ brief, handoff: { kind: 'design', summary: 'Old design' } })); } },messenger,{ async generate() { return [render]; } }).tick();
    await store.saveMedia(original.conversationId!, render, Buffer.from([0xff,0xd8,0xff,0xd9]));
    const pending = await store.ingest(incoming({ chatId: chat, isGroup: group, text: 'Old revision' }), 'linq');
    const operator = await store.queueOperator(original.conversationId!, 'Old operator reply', randomUUID());
    const payload = commandEvent(name, danny, chat, group);
    const reset = await deliver(payload);
    assert.notEqual(reset.conversationId, original.conversationId);
    assert.equal((await store.getTurn(pending.turnId!))?.status, 'cancelled');
    assert.equal((await store.getTurn(operator!.id))?.status, 'cancelled');
    assert.ok((await store.getConversation(original.conversationId!))?.archived_at);
    assert.equal(await store.pause(original.conversationId!, false), undefined);
    assert.equal(await store.queueOperator(original.conversationId!, 'Late reply', randomUUID()), undefined);
    const duplicate = await deliver(payload);
    assert.equal(duplicate.turnId, reset.turnId); assert.equal(duplicate.conversationId, reset.conversationId);
    const sameMessage = structuredClone(payload); sameMessage.event_id = randomUUID();
    assert.equal((await deliver(sameMessage)).turnId, reset.turnId);
    await worker().tick();
    assert.match(sent.at(-1)!.text, group ? /Started a fresh conversation/ : /Started a fresh project/);
    const ctx = await store.context(reset.conversationId);
    assert.deepEqual(ctx?.conversation.brief, decision().brief);
    assert.equal(ctx?.messages.length, 0); assert.equal(ctx?.referenceMessages?.length, 0);
    assert.equal(ctx?.handoffs.length, 0); assert.equal(ctx?.hasAssistantReply, false);
    const next = await store.ingest(incoming({ chatId: chat, sender: danny, isGroup: group, text: 'New project' }), 'linq');
    assert.equal(next.conversationId, reset.conversationId);
    await worker({ async respond(context) {
      assert.deepEqual(context.messages.map((message) => message.text), ['New project']);
      assert.equal(context.hasAssistantReply, false); assert.equal(context.conversation.brief.style, null);
      return decision();
    } }).tick();
    assert.equal((await store.context(original.conversationId!))?.conversation.brief.style, 'Oak');
    assert.ok(await store.readMedia(render.id));
    const archived = (await request(app).get('/api/conversations?archived=true').set(auth).expect(200)).body.conversations;
    assert.ok(archived.some((item: { id: string }) => item.id === original.conversationId));
    const audit = (await request(app).get(`/api/conversations/${reset.conversationId}`).set(auth).expect(200)).body;
    assert.ok(audit.messages.some((message: { text: string }) => message.text === name));
  }
});

for (const resetCommand of ['/new', '/client', '/contractor']) test(`/status works during rendering and ${resetCommand} suppresses the old result`, async () => {
  const chat = randomUUID(); const original = await prepareFirstDesign(store, incoming({ chatId: chat, isGroup: false }), 'linq');
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const render: Attachment = { id: randomUUID(), url: '/old-design', mimeType: 'image/jpeg', filename: 'old.jpg', sizeBytes: 4 };
  const run = worker({ async respond(ctx) { return confirmedDesign(ctx, decision({ reply: 'Old result', brief: { ...decision().brief, propertyAddress: 'Old address' }, handoff: { kind: 'design', summary: 'Old design' } })); } },messenger,
    { async generate() { entered(); await gate; return [render]; } }).tick();
  await started;
  try {
    await command('/status',kunal,chat,false);
    await worker().tick();
    assert.match(sent.at(-1)!.text, /1 working/);
    const reset = await command(resetCommand,danny,chat,false);
    await worker().tick();
    assert.match(sent.at(-1)!.text, /fresh (conversation|project)/);
    release(); await run;
    assert.equal(sent.some((item) => item.text === 'Old result' || item.attachments.length), false);
    assert.equal((await store.getTurn(original.turnId!))?.status, 'cancelled');
    assert.equal((await store.context(reset.conversationId))?.conversation.brief.propertyAddress, null);
  } finally { release(); await run; }
});

test('status reports only the current chat and stays available while paused', async () => {
  const other = await store.ingest(incoming(), 'linq');
  await worker({ async respond() { return decision({ handoff: { kind: 'human', summary: 'Other project needs help' } }); } }).tick();
  const current = await command('/pause',kunal);
  await worker().tick();
  const chat = (await store.getConversation(current.conversationId))!.external_id;
  await command('/status',danny,chat);
  await worker().tick();
  assert.match(sent.at(-1)!.text, /paused.*0 working, 0 queued, 0 failed.*none/);
  assert.equal((await store.getConversation(other.conversationId!))?.paused, true);
});

test('command delivery retries reuse one reply and never execute reset twice', async () => {
  const payload = commandEvent('/reset'); const queued = await deliver(payload);
  const keys: string[] = [];
  const transport: Messenger = { async send(_chat,_text,key) { keys.push(key); if (keys.length === 1) throw new Error('Ambiguous delivery'); return `sent-${key}`; } };
  await worker(noModel,transport).tick();
  await pool.query("UPDATE turns SET lease_until=now()-interval '1 second',available_at=now() WHERE id=$1", [queued.turnId]);
  await worker(noModel,transport).tick();
  assert.deepEqual(keys,[queued.turnId,queued.turnId]);
  assert.equal((await deliver(payload)).turnId, queued.turnId);
  assert.equal((await store.listConversations()).length, 1);
  assert.equal((await store.listConversations(true)).length, 1);
});

test('a status command does not prevent retrying the latest failed design request', async () => {
  const chat = randomUUID(); const original = await store.ingest(incoming({ chatId: chat }), 'linq');
  await worker({ async respond() { throw Object.assign(new Error('Unavailable'), { status: 400 }); } }).tick();
  await worker().tick();
  await command('/status',kunal,chat); await worker().tick();
  assert.match(sent.at(-1)!.text, /1 failed/);
  const retry = await store.ingest(incoming({ chatId: chat, text: 'try again' }), 'linq');
  assert.equal(retry.turnId, original.turnId);
});

test('attachments on a command do not accidentally discard project context', async () => {
  const payload = commandEvent('/reset');
  payload.data.parts.push({ type: 'media', id: 'photo', url: 'https://cdn.linqapp.com/photo.jpg', mime_type: 'image/jpeg' });
  const queued = await deliver(payload);
  await worker().tick();
  assert.match(sent.at(-1)!.text, /without attachments/);
  assert.equal((await store.listConversations(true)).length, 0);
  assert.equal((await store.context(queued.conversationId))?.referenceMessages?.length, 0);
});

test('concurrent reset deliveries keep one active session and preserve webhook deduplication', async () => {
  const chat = randomUUID();
  const beforeReset = incoming({ chatId: chat, text: 'Previous project' });
  const previous = await store.ingest(beforeReset, 'linq');
  const payload = commandEvent('/reset',kunal,chat);
  const resets = await Promise.all([deliver(payload),deliver(payload),deliver(payload)]);
  assert.ok(resets.every((result) => result.conversationId === resets[0].conversationId && result.turnId === resets[0].turnId));
  const current = resets[0].conversationId;
  const later = await Promise.all(Array.from({ length: 4 },(_,index) => store.ingest(incoming({ chatId: chat, text: `New note ${index}` }), 'linq')));
  assert.ok(later.every((result) => result.conversationId === current));
  const oldReplay = await store.ingest({ ...beforeReset, eventId: randomUUID() }, 'linq');
  assert.equal(oldReplay.duplicate, true); assert.equal(oldReplay.conversationId, previous.conversationId);
  assert.equal((await store.listConversations()).length, 1);
  assert.equal((await store.listConversations(true)).length, 1);
  const ctx = await store.context(current);
  assert.equal(ctx?.messages.length, 4);
  assert.ok(ctx?.messages.every((message) => message.text.startsWith('New note')));
});

test('upgrading an existing database preserves projects and does not notify historical failures', async () => {
  const upgradeSchema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
  const upgraded = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${upgradeSchema}` });
  try {
    await upgraded.query('CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    for (const name of ['001_initial.sql','002_personality_reactions.sql','003_contractor_signups.sql']) {
      await upgraded.query(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));
      await upgraded.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
    }
    const id = randomUUID(); const chat = randomUUID(); const failed = randomUUID();
    const brief = { ...decision().brief, propertyAddress: '123 Example St' };
    await upgraded.query("INSERT INTO conversations(id,external_id,channel,brief) VALUES($1,$2,'linq',$3)",[id,chat,JSON.stringify(brief)]);
    await upgraded.query("INSERT INTO messages(conversation_id,role,sender,text) VALUES($1,'user','homeowner','Saved project')",[id]);
    await upgraded.query("INSERT INTO turns(id,conversation_id,through_seq,status) VALUES($1,$2,1,'failed')",[failed,id]);
    await migrate(upgraded);
    const migrated = new Store(upgraded,0);
    assert.deepEqual((await migrated.context(id))?.conversation.brief,brief);
    assert.equal((await migrated.getConversation(id))?.role_override, null);
    assert.equal((await migrated.context(id))?.messages[0]?.text,'Saved project');
    assert.ok((await migrated.getTurn(failed))?.failure_notified_at);
    assert.equal(await migrated.claim(),null);
    assert.equal((await migrated.ingest(incoming({chatId:chat}), 'linq')).conversationId,id);
  } finally {
    await upgraded.end(); await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`);
  }
});
