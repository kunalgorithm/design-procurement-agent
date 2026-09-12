import test from 'node:test';
import assert from 'node:assert/strict';
import Linq from '@linqapp/sdk';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { normalizeEvent, LinqMessenger } from '../src/linq.js';
import { modelAttachment, OpenAIAgent } from '../src/agent.js';
import { writeSandboxMedia } from '../src/media.js';
import { isStopRequest, participantContext, senderRole, validateDecision, type Attachment } from '../src/domain.js';
import { buildKitchenPrompt, kitchenReferenceAttachments, OpenAIDesignStudio, shouldGenerateKitchen } from '../src/design.js';
import { readConfig } from '../src/config.js';
import { classifyError } from '../src/worker.js';
import { event, decision, context } from './fixtures.js';

test('normalizes a group message with text and media without dropping sender identity', () => {
  const payload = event();
  payload.data.parts.push({ type: 'media', id: 'photo-1', url: 'https://cdn.linqapp.com/kitchen.jpg', mime_type: 'image/jpeg', filename: 'kitchen.jpg', size_bytes: 1024 });
  const result = normalizeEvent(payload)!;
  assert.equal(result.chatId, payload.data.chat.id);
  assert.equal(result.sender, '+12025550101');
  assert.equal(result.owner, '+12025550100');
  assert.equal(result.isGroup, true);
  assert.equal(result.attachments[0]?.mimeType, 'image/jpeg');
});

test('ignores lifecycle events, outbound echoes, self messages, and empty events', () => {
  assert.equal(normalizeEvent({ event_type: 'message.delivered' }), null);
  const outbound = event(); outbound.data.direction = 'outbound';
  assert.equal(normalizeEvent(outbound), null);
  const self = event(); self.data.sender_handle.is_me = true;
  assert.equal(normalizeEvent(self), null);
  const empty = event(); empty.data.parts = [];
  assert.equal(normalizeEvent(empty), null);
});

test('rejects incompatible webhook versions and malformed group IDs', () => {
  assert.throws(() => normalizeEvent({ ...event(), webhook_version: '2025-01-01' }));
  const payload = event(); payload.data.chat.id = 'invalid';
  assert.throws(() => normalizeEvent(payload));
});

test('sandbox groups already identify the homeowner and contractor', () => {
  assert.equal(senderRole('Homeowner'), 'homeowner');
  assert.equal(senderRole('contractor'), 'contractor');
  assert.equal(senderRole('+12025550101'), null);
  const sandbox = context();
  sandbox.conversation.channel = 'sandbox';
  assert.match(participantContext(sandbox), /already includes the homeowner and the contractor/);
  assert.match(participantContext(sandbox), /Do not ask who is who/);
  const linq = context();
  linq.messages.push({ id: randomUUID(), seq: '1', conversation_id: linq.conversation.id, role: 'user', sender: 'homeowner', text: 'Hi', created_at: new Date(), attachments: [] });
  assert.match(participantContext(linq), /"homeowner" is the homeowner/);
  assert.equal(participantContext(context()).includes('Known sender roles'), false);
});

test('STOP matches explicit opt-outs, not ordinary design discussion', () => {
  for (const text of ['STOP', 'unsubscribe.', ' Stop all! ', 'opt-out']) assert.equal(isStopRequest(text), true);
  for (const text of ['Can we stop using oak?', 'cancel the island', 'end panels']) assert.equal(isStopRequest(text), false);
});

test('accepts link previews and optional sent timestamps, but ignores reconciled history', () => {
  const payload = event(); payload.data.parts = [{ type: 'link', value: 'https://example.com/inspiration' }];
  const result = normalizeEvent({ ...payload, created_at: payload.data.sent_at, data: { ...payload.data, sent_at: null } });
  assert.equal(result?.text, 'https://example.com/inspiration');
  assert.equal(result?.sentAt, payload.data.sent_at);
  assert.equal(normalizeEvent({ ...payload, data: { ...payload.data, reconciled_at: new Date().toISOString() } }), null);
});

test('handoffs require useful context and cannot duplicate open work', () => {
  const ctx = context();
  const request = decision({ handoff: { kind: 'design', summary: 'Start the kitchen design.' } });
  assert.equal(validateDecision(request, ctx).handoff, null);
  request.brief = { ...request.brief, propertyAddress: '123 Example Street' };
  const ready = validateDecision(request, ctx);
  assert.equal(ready.handoff?.kind, 'design');
  assert.equal(ready.brief.scope, 'Kitchen redesign');
  ctx.handoffs.push({ id: randomUUID(), kind: 'design', summary: 'Design requested', status: 'open' });
  assert.equal(validateDecision(request, ctx).handoff, null);
  const proposal = decision({ handoff: { kind: 'proposal', summary: 'Price the kitchen.' } });
  proposal.brief = { ...proposal.brief, propertyAddress: '123 Example Street', scope: 'Kitchen redesign' };
  assert.equal(validateDecision(proposal, context()).handoff, null);
  proposal.brief = { ...proposal.brief, homeownerName: 'Alex', contractorName: 'Sam' };
  assert.equal(validateDecision(proposal, context()).handoff?.kind, 'proposal');
  assert.equal(validateDecision(decision({ handoff: { kind: 'human', summary: 'Please help' } }), context()).handoff?.kind, 'human');
});

test('kitchen generation uses reference photos and the property address', async () => {
  const ctx = context();
  const id = randomUUID();
  await writeSandboxMedia(id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { mimeType: 'image/jpeg', filename: 'kitchen.jpg' });
  ctx.messages.push({
    id: randomUUID(), seq: '1', conversation_id: ctx.conversation.id, role: 'user', sender: 'homeowner',
    text: 'Keep the window wall.', created_at: new Date(),
    attachments: [{ id, url: `/api/media/${id}`, filename: 'kitchen.jpg', mimeType: 'image/jpeg', sizeBytes: 4 }],
  });
  const output = decision({
    reply: 'Here is a redesign.',
    handoff: { kind: 'design', summary: 'Generate the first kitchen.' },
    brief: { ...decision().brief, propertyAddress: '123 Example Street', style: 'warm oak' },
  });
  assert.equal(shouldGenerateKitchen(output), true);
  assert.equal(kitchenReferenceAttachments(ctx).length, 1);
  assert.match(buildKitchenPrompt(ctx, output), /123 Example Street/);
  assert.match(buildKitchenPrompt(ctx, output), /Keep the window wall/);
  let usedEdit = false;
  const client = {
    images: {
      async edit(body: { prompt: string; image: unknown[] }) {
        usedEdit = true;
        assert.match(body.prompt, /123 Example Street/);
        assert.equal(body.image.length, 1);
        return { data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }] };
      },
      async generate() { throw new Error('should edit when reference photos exist'); },
    },
  };
  const attachments = await new OpenAIDesignStudio(client as never, 'gpt-image-1.5').generate(ctx, output);
  assert.equal(usedEdit, true);
  assert.equal(attachments.length, 1);
  assert.match(attachments[0]!.url, /^\/api\/media\//);
  assert.equal(attachments[0]!.mimeType, 'image/jpeg');
});

test('kitchen generation falls back to text-only images when no photos are available', async () => {
  const ctx = context();
  const output = decision({
    handoff: { kind: 'design', summary: 'Generate from the address.' },
    brief: { ...decision().brief, propertyAddress: '88 Pine Street' },
  });
  const client = {
    images: {
      async edit() { throw new Error('should generate without reference photos'); },
      async generate(body: { prompt: string }) {
        assert.match(body.prompt, /88 Pine Street/);
        return { data: [{ b64_json: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }] };
      },
    },
  };
  const attachments = await new OpenAIDesignStudio(client as never, 'gpt-image-1.5').generate(ctx, output);
  assert.equal(attachments[0]?.mimeType, 'image/jpeg');
});

test('only passes supported, bounded files on the Linq CDN to the model', () => {
  const file: Attachment = { id: '1', url: 'https://cdn.linqapp.com/kitchen.jpg', filename: 'kitchen.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 };
  assert.equal(modelAttachment(file)?.type, 'input_image');
  assert.equal(modelAttachment({ ...file, mimeType: 'application/pdf' })?.type, 'input_file');
  for (const url of ['invalid', 'http://cdn.linqapp.com/x', 'https://localhost/x', 'https://cdn.linqapp.com.evil.example/x', 'https://user:password@cdn.linqapp.com/x']) {
    assert.equal(modelAttachment({ ...file, url }), null);
  }
  assert.equal(modelAttachment({ ...file, mimeType: 'audio/mp4' }), null);
  assert.equal(modelAttachment({ ...file, sizeBytes: 21 * 1024 * 1024 }), null);
  assert.equal(modelAttachment({ ...file, url: 'data:image/jpeg;base64,/9j/AA' })?.type, 'input_image');
  assert.equal(modelAttachment({ ...file, url: `/local/media/${randomUUID()}` })?.type, 'input_image');
  assert.equal(modelAttachment({ ...file, url: `/api/media/${randomUUID()}` })?.type, 'input_image');
});

test('live configuration requires both Linq credentials; sandbox does not', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/agent_test', ADMIN_API_KEY: 'test-admin-key-that-is-at-least-32', OPENAI_API_KEY: 'not-a-real-key' };
  assert.equal(readConfig(env).MESSAGING_MODE, 'sandbox');
  assert.throws(() => readConfig({ ...env, MESSAGING_MODE: 'live' }));
  assert.equal(readConfig({ ...env, MESSAGING_MODE: 'live', LINQ_API_KEY: 'test', LINQ_WEBHOOK_SECRET: 'test' }).MESSAGING_MODE, 'live');
  assert.equal(readConfig(env).OPENAI_IMAGE_MODEL, 'gpt-image-1.5');
});

test('transient upstream failures retry; authentication and bad requests stop for review', () => {
  assert.equal(classifyError({ status: 429 }).permanent, false);
  assert.equal(classifyError({ status: 503 }).permanent, false);
  assert.equal(classifyError(new Error('network')).permanent, false);
  assert.equal(classifyError({ status: 401 }).permanent, true);
  assert.equal(classifyError({ status: 400 }).code, 'UPSTREAM_400');
});

test('Linq SDK sends into the existing chat with a stable body idempotency key', async () => {
  const chatId = randomUUID(); const key = randomUUID();
  const client = new Linq({ apiKey: 'not-a-real-key', maxRetries: 0, fetch: async (url, init) => {
    assert.equal(String(url), `https://api.linqapp.com/api/partner/v3/chats/${chatId}/messages`);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { message: { parts: [{ type: 'text', value: 'Hello' }], idempotency_key: key } });
    return new Response(JSON.stringify({ message: { id: 'provider-message-id' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(await new LinqMessenger(client).send(chatId, 'Hello', key), 'provider-message-id');
});

test('OpenAI request uses strict structured output, sender context, and actual image content', async () => {
  const ctx = context(); const expected = decision();
  ctx.messages.push({ id: randomUUID(), seq: '1', conversation_id: ctx.conversation.id, role: 'user', sender: '+12025550101', text: 'Here is our kitchen', created_at: new Date(),
    attachments: [{ id: 'image', url: 'https://cdn.linqapp.com/kitchen.jpg', filename: 'kitchen.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 }] });
  const client = new OpenAI({ apiKey: 'not-a-real-key', maxRetries: 0, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input[2].content[1].type, 'input_image');
    assert.match(body.input[2].content[0].text, /12025550101/);
    assert.match(body.input[2].content[0].text, /"role":null/);
    return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(expected), annotations: [] }] }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await new OpenAIAgent(client, 'gpt-5-mini').respond(ctx), expected);
});

test('an expired media URL falls back to text with an explicit missing-content instruction', async () => {
  const ctx = context(); const expected = decision(); let calls = 0;
  ctx.messages.push({ id: randomUUID(), seq: '1', conversation_id: ctx.conversation.id, role: 'user', sender: 'homeowner', text: 'Look at this kitchen', created_at: new Date(),
    attachments: [{ id: 'image', url: 'https://cdn.linqapp.com/expired.jpg', filename: 'kitchen.jpg', mimeType: 'image/jpeg', sizeBytes: 1024 }] });
  const client = new OpenAI({ apiKey: 'not-a-real-key', maxRetries: 0, fetch: async (_url, init) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'Failed to download image', type: 'invalid_request_error', code: 'invalid_image_url' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.input[2].content.length, 1);
    assert.match(body.input[2].content[0].text, /"role":"homeowner"/);
    assert.match(body.input.at(-1).content, /No attachment contents are available/);
    return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(expected), annotations: [] }] }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await new OpenAIAgent(client, 'gpt-5-mini').respond(ctx), expected);
  assert.equal(calls, 2);
});

test('sandbox photos are inlined for the model', async () => {
  const ctx = context(); const expected = decision();
  const id = randomUUID();
  await writeSandboxMedia(id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { mimeType: 'image/jpeg', filename: 'kitchen.jpg' });
  ctx.conversation.channel = 'sandbox';
  ctx.messages.push({ id: randomUUID(), seq: '1', conversation_id: ctx.conversation.id, role: 'user', sender: 'homeowner', text: 'Here is the kitchen', created_at: new Date(),
    attachments: [{ id, url: `/api/media/${id}`, filename: 'kitchen.jpg', mimeType: 'image/jpeg', sizeBytes: 4 }] });
  const client = new OpenAI({ apiKey: 'not-a-real-key', maxRetries: 0, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.input[2].content[1].type, 'input_image');
    assert.match(body.input[2].content[1].image_url, /^data:image\/jpeg;base64,/);
    return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(expected), annotations: [] }] }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await new OpenAIAgent(client, 'gpt-5-mini').respond(ctx), expected);
});
