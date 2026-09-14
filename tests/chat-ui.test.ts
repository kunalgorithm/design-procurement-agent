import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { Store } from '../src/store.js';

const env = {
  DATABASE_URL: 'postgresql://localhost/agent_test',
  ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32',
  OPENAI_API_KEY: 'not-a-real-key',
};

function app(nodeEnv: 'development' | 'production', store: Partial<Store> = {}) {
  return createApp(readConfig({ ...env, NODE_ENV: nodeEnv }), { async readMedia() { return null; }, ...store } as Store);
}

const auth = { Authorization: `Bearer ${env.ADMIN_API_KEY}` };

test('development serves the sandbox chat UI and bootstraps an admin token', async () => {
  const conversationId = randomUUID();
  const turnId = randomUUID();
  const server = app('development', {
    async ingest() { return { conversationId, turnId, duplicate: false }; },
    async getTurn(id) { return { id, status: 'done', decision: { reply: 'Hello', brief: {}, handoff: null } } as never; },
    async listConversations() { return []; },
  });
  const page = await request(server).get('/sandbox').expect(200);
  assert.match(page.headers['content-type'] ?? '', /html/);
  assert.match(page.text, /FORM sandbox/);
  assert.match(page.text, /Clear chat/);
  await request(server).get('/app.js').expect(200);
  const config = await request(server).get('/config').expect(200);
  assert.equal(config.body.authRequired, false);
  assert.equal(config.body.token, env.ADMIN_API_KEY);
  await request(server).post('/api/sandbox/messages').send({ message: 'hi' }).expect(401);
  const queued = await request(server).post('/api/sandbox/messages').set(auth).send({ message: 'hi' }).expect(202);
  assert.equal(queued.body.conversationId, conversationId);
  assert.ok(queued.body.sessionId);
  const turn = await request(server).get(`/api/turns/${turnId}`).set(auth).expect(200);
  assert.equal(turn.body.turn.decision.reply, 'Hello');
});

test('sandbox chat accepts a photo-only message and serves it back', async () => {
  const conversationId = randomUUID();
  const turnId = randomUUID();
  let ingested: { attachments?: Array<{ id: string; url: string; mimeType: string }>; text?: string } | undefined;
  const server = app('production', {
    async ingest(message) { ingested = message; return { conversationId, turnId, duplicate: false }; },
  });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  await request(server).post('/api/sandbox/messages').set(auth).send({ message: '' }).expect(400);
  await request(server).post('/api/sandbox/messages').set(auth).send({
    attachments: [{ filename: 'kitchen.jpg', mimeType: 'image/jpeg', data: jpeg }],
  }).expect(202);
  assert.equal(ingested?.text, '');
  assert.equal(ingested?.attachments?.[0]?.mimeType, 'image/jpeg');
  assert.match(ingested?.attachments?.[0]?.url ?? '', /^\/api\/media\//);
  const media = await request(server).get(ingested!.attachments![0]!.url).set(auth).expect(200);
  assert.match(media.headers['content-type'] ?? '', /image\/jpeg/);
  await request(server).get(ingested!.attachments![0]!.url).expect(401);
  await request(server).post('/api/sandbox/messages').set(auth).send({
    attachments: [{ filename: 'kitchen.jpg', mimeType: 'image/jpeg', data: Buffer.from('nope').toString('base64') }],
  }).expect(400);
});

test('admin can pause and clear a sandbox conversation', async () => {
  const id = randomUUID();
  let paused: boolean | undefined;
  let cleared: { id: string; channel: string } | undefined;
  const server = app('production', {
    async getConversation() { return { id, channel: 'sandbox', paused: false } as never; },
    async pause(_id, value) { paused = value; return { id, channel: 'sandbox', paused: value } as never; },
    async clearConversation(conversationId, channel) { cleared = { id: conversationId, channel: channel ?? 'sandbox' }; return { id, channel: 'sandbox' } as never; },
    async context() { return { conversation: { id, channel: 'sandbox', paused: false, brief: {} }, messages: [], handoffs: [] } as never; },
    async listConversationTurns() { return []; },
  });
  await request(server).patch(`/api/conversations/${id}`).set(auth).send({ paused: true }).expect(200);
  assert.equal(paused, true);
  await request(server).delete(`/api/conversations/${id}`).set(auth).expect(200);
  assert.deepEqual(cleared, { id, channel: 'sandbox' });
});

test('production serves the sandbox UI but does not expose the admin token', async () => {
  const server = app('production');
  const page = await request(server).get('/sandbox').expect(200);
  assert.match(page.headers['content-type'] ?? '', /html/);
  const config = await request(server).get('/config').expect(200);
  assert.equal(config.body.authRequired, true);
  assert.equal(config.body.token, undefined);
  await request(server).post('/local/messages').send({ message: 'hi' }).expect(404);
  await request(server).post('/api/sandbox/messages').send({ message: 'hi' }).expect(401);
});
