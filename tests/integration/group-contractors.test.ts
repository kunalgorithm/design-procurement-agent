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
import { contractorSignupSchema } from '../../src/contractor-schema.js';
import { identifiedSenderRole, participantContext, type AgentContext, type ChatParticipants } from '../../src/domain.js';
import { incoming, decision, event, sign, webhookSecret } from '../fixtures.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test database');
const schema = `groups_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const store = new Store(pool, 0);
const contractorPhone = '+12025550101'; const homeownerPhone = '+12025550102'; const line = '+16504447573';
const roster: ChatParticipants = { handles: [contractorPhone, homeownerPhone], owner: line, isGroup: true };
const config = readConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32',
  OPENAI_API_KEY: 'unused', MESSAGING_MODE: 'live', LINQ_API_KEY: 'unused', LINQ_WEBHOOK_SECRET: webhookSecret });

async function signup(extra = {}, assignedLine = line) {
  const input = contractorSignupSchema.parse({ submissionId: randomUUID(), firstName: 'Sam', lastName: 'Rivera',
    phone: '2025550101', email: 'contractor@example.com', businessName: 'Example Kitchens', ...extra });
  await store.registerContractor(input, assignedLine); return input;
}

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('TRUNCATE conversations,contractor_signups,webhook_events CASCADE'); });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

for (const sender of [homeownerPhone, contractorPhone]) test(`signed group event from ${sender} resolves signup before the first reply and survives a restart`, async () => {
  const registration = await signup();
  const payload = event(); payload.data.chat.owner_handle.handle = line; payload.data.sender_handle.handle = sender;
  payload.data.parts = [{ type: 'text', value: 'Sarah is the homeowner. The address is 123 Test Street. We want warm oak.' }];
  const app = createApp(config, store); const body = JSON.stringify(payload);
  const receipt = await request(app).post('/webhooks/linq').set(sign(body)).set('Content-Type', 'application/json').send(body).expect(200);
  let calls = 0; const sent: string[] = [];
  const worker = new Worker(store, { async respond(ctx) {
    calls++;
    assert.equal(ctx.registeredContractors?.[0]?.id, registration.submissionId);
    assert.equal(ctx.conversation.contractor_signup_id, registration.submissionId);
    assert.equal(identifiedSenderRole(ctx, contractorPhone), 'contractor');
    assert.equal(identifiedSenderRole(ctx, homeownerPhone), null);
    assert.match(participantContext(ctx), /Example Kitchens/);
    assert.equal(ctx.hasAssistantReply, false);
    return decision({ reply: 'Hi Sarah, I’m FORM, working with Sam. Can you share photos of the kitchen?',
      brief: { ...decision().brief, propertyAddress: '123 Test Street', style: 'warm oak', homeownerName: 'Sarah' } });
  } }, { async chatParticipants(id) { assert.equal(id, payload.data.chat.id); return roster; },
    async send(id, text) { assert.equal(id, payload.data.chat.id); sent.push(text); return randomUUID(); } },
  pino({ level: 'silent' }), 100, 'live');
  await worker.tick();
  const duplicate = await request(app).post('/webhooks/linq').set(sign(body)).set('Content-Type', 'application/json').send(body).expect(200);
  assert.equal(duplicate.body.duplicate, true); assert.equal(await worker.tick(), false);
  assert.equal(calls, 1); assert.equal(sent.length, 1);
  const restarted = await new Store(pool).context(receipt.body.conversationId);
  assert.equal(restarted?.conversation.brief.contractorName, 'Sam Rivera');
  assert.equal(restarted?.conversation.brief.propertyAddress, '123 Test Street');
  assert.equal(restarted?.conversation.brief.style, 'warm oak');
  assert.equal(restarted?.hasAssistantReply, true);
});

test('projects and owned lines stay isolated; a phone in text never establishes a participant', async () => {
  await signup();
  const first = await store.ingest(incoming({ owner: line, sender: homeownerPhone }), 'linq');
  await store.syncChatParticipants(first.conversationId!, roster);
  const other = await store.ingest(incoming({ owner: line, sender: '+12025550102', text: `Call ${contractorPhone}` }), 'linq');
  await store.syncChatParticipants(other.conversationId!, { ...roster, handles: ['+12025550102', '+12025550103'] });
  assert.equal((await store.context(other.conversationId!))?.registeredContractors?.length, 0);
  assert.equal((await store.context(other.conversationId!))?.conversation.contractor_signup_id, null);
  const anotherLine = await store.ingest(incoming({ owner: '+12025550100', sender: contractorPhone }), 'linq');
  await store.syncChatParticipants(anotherLine.conversationId!, { ...roster, owner: '+12025550100' });
  assert.equal((await store.context(anotherLine.conversationId!))?.registeredContractors?.length, 0);
  await assert.rejects(() => store.syncChatParticipants(first.conversationId!, { ...roster, owner: '+12025550100' }), /CHAT_OWNER_MISMATCH/);
});

test('same contractor can own two groups; participants removed from one are not current members', async () => {
  const registration = await signup();
  const groups = await Promise.all([1, 2].map(() => store.ingest(incoming({ owner: line, sender: homeownerPhone }), 'linq')));
  for (const group of groups) await store.syncChatParticipants(group.conversationId!, roster);
  assert.notEqual(groups[0]!.conversationId, groups[1]!.conversationId);
  for (const group of groups) assert.equal((await store.context(group.conversationId!))?.conversation.contractor_signup_id, registration.submissionId);
  await store.syncChatParticipants(groups[0]!.conversationId!, { ...roster, handles: [homeownerPhone] });
  assert.equal((await store.context(groups[0]!.conversationId!))?.registeredContractors?.length, 0);
  assert.equal((await store.context(groups[1]!.conversationId!))?.registeredContractors?.length, 1);
});

test('conflicting signup identities and two contractors never bind a group arbitrarily', async () => {
  await signup(); await signup({ firstName: 'Different person' });
  const conflict = await store.ingest(incoming({ owner: line, sender: homeownerPhone }), 'linq');
  await store.syncChatParticipants(conflict.conversationId!, roster);
  const ctx = (await store.context(conflict.conversationId!))!;
  assert.deepEqual(ctx.ambiguousContractorPhones, [contractorPhone]);
  assert.equal(ctx.registeredContractors?.length, 0); assert.equal(ctx.conversation.contractor_signup_id, null);
  await pool.query('TRUNCATE conversations,contractor_signups,webhook_events CASCADE');
  await signup(); await signup({ phone: homeownerPhone, firstName: 'Alex' });
  const group = await store.ingest(incoming({ owner: line }), 'linq');
  await store.syncChatParticipants(group.conversationId!, roster);
  assert.equal((await store.context(group.conversationId!))?.registeredContractors?.length, 2);
  assert.equal((await store.context(group.conversationId!))?.conversation.contractor_signup_id, null);
});

test('roster outage retries before calling the model or replying, then recovers the saved message', async () => {
  await signup(); const queued = await store.ingest(incoming({ owner: line, sender: homeownerPhone }), 'linq');
  let failing = true; let models = 0; let sends = 0;
  const worker = new Worker(store, { async respond(ctx) { models++; return decision({ brief: ctx.conversation.brief }); } }, {
    async chatParticipants() { if (failing) throw new Error('temporary outage'); return roster; },
    async send() { sends++; return randomUUID(); },
  }, pino({ level: 'silent' }), 100, 'live');
  await worker.tick(); assert.equal(models, 0); assert.equal(sends, 0);
  failing = false; await pool.query("UPDATE turns SET available_at=now(),lease_until=now()-interval '1 second' WHERE id=$1", [queued.turnId]);
  await worker.tick(); assert.equal(models, 1); assert.equal(sends, 1);
});

test('message bursts keep both senders, photos, and corrections in one model turn', async () => {
  await signup(); const chatId = randomUUID(); let ctx: AgentContext | undefined;
  await store.ingest(incoming({ chatId, owner: line, sender: contractorPhone, text: 'Kitchen width is 12 ft.' }), 'linq');
  await store.ingest(incoming({ chatId, owner: line, sender: homeownerPhone, text: 'I want green cabinets.',
    attachments: [{ id: randomUUID(), url: 'https://cdn.linqapp.com/test.jpg', mimeType: 'image/jpeg', filename: 'kitchen.jpg', sizeBytes: 100 }] }), 'linq');
  await store.ingest(incoming({ chatId, owner: line, sender: contractorPhone, text: 'Correction: width is 13 ft.' }), 'linq');
  const worker = new Worker(store, { async respond(value) { ctx = value; return decision({
    brief: { ...value.conversation.brief, reportedMeasurements: '13 ft', style: 'green cabinets' } }); } }, {
    async chatParticipants() { return roster; }, async send() { return randomUUID(); },
  }, pino({ level: 'silent' }), 100, 'live');
  await worker.tick(); assert.equal(ctx?.messages.length, 3); assert.equal(ctx?.messages[1]?.attachments.length, 1);
  assert.equal(ctx?.messages[2]?.text, 'Correction: width is 13 ft.'); assert.equal(await worker.tick(), false);
  assert.equal((await store.context(ctx!.conversation.id))?.conversation.brief.reportedMeasurements, '13 ft');
});
