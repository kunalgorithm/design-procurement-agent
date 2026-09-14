import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import Linq from '@linqapp/sdk';
import { OpenAIAgent } from '../src/agent.js';
import { LinqMessenger } from '../src/linq.js';
import { validateDecision, type Attachment, type Message } from '../src/domain.js';
import { buildKitchenPrompt, OpenAIDesignStudio } from '../src/design.js';
import type { MediaRepository } from '../src/media.js';
import { context, decision } from './fixtures.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const attachment = (id = randomUUID()): Attachment => ({ id, url: `/api/media/${id}`, filename: 'kitchen-redesign.jpg', mimeType: 'image/jpeg', sizeBytes: jpeg.length });
function repository(): MediaRepository {
  const providers = new Map<string, string>();
  return { async readMedia() { return { bytes: jpeg, mimeType: 'image/jpeg', filename: 'kitchen-redesign.jpg' }; },
    async saveMedia() {}, async providerAttachment(id) { return providers.get(id) ?? null; },
    async saveProviderAttachment(id, providerId) { providers.set(id, providerId); } };
}

function modelClient(inspect: (request: any) => void) {
  return new OpenAI({ apiKey: 'test', maxRetries: 0, fetch: async (_url, init) => {
    inspect(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(decision()), annotations: [] }] }] }), { headers: { 'content-type': 'application/json' } });
  } });
}

test('a live render is pre-uploaded once, then sent as media with the same text and key on retry', async () => {
  const photo = attachment(); const sent: unknown[] = []; let uploads = 0; let creates = 0;
  const linq = new Linq({ apiKey: 'test', maxRetries: 0, fetch: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('/attachments')) {
      creates++;
      assert.deepEqual(body, { filename: photo.filename, content_type: 'image/jpeg', size_bytes: jpeg.length });
      return new Response(JSON.stringify({ attachment_id: 'uploaded-image', upload_url: 'https://upload.example/image', required_headers: { 'Content-Type': 'image/jpeg', 'x-test': 'signed-header' } }), { headers: { 'content-type': 'application/json' } });
    }
    sent.push(body);
    return new Response(JSON.stringify({ message: { id: 'sent-image' } }), { headers: { 'content-type': 'application/json' } });
  } });
  const transport = new LinqMessenger(linq, repository(), async (url, init) => {
    uploads++;
    assert.equal(String(url), 'https://upload.example/image');
    assert.equal(init?.method, 'PUT');
    assert.deepEqual(init?.headers, { 'Content-Type': 'image/jpeg', 'x-test': 'signed-header' });
    assert.deepEqual(Buffer.from(init!.body as Uint8Array), jpeg);
    return new Response(null, { status: 200 });
  });
  const chat = randomUUID(); const key = randomUUID();
  await transport.send(chat, 'Here is your design.', key, [photo]);
  await transport.send(chat, 'Here is your design.', key, [photo]);
  assert.equal(creates, 1); assert.equal(uploads, 1);
  assert.deepEqual(sent[0], { message: { parts: [{ type: 'text', value: 'Here is your design.' }, { type: 'media', attachment_id: 'uploaded-image' }], idempotency_key: key } });
  assert.deepEqual(sent[0], sent[1]);
});

test('failed media upload never sends a misleading text-only design presentation', async () => {
  let sends = 0;
  const linq = new Linq({ apiKey: 'test', maxRetries: 0, fetch: async (url) => {
    if (!String(url).endsWith('/attachments')) { sends++; assert.fail('Must not send before upload succeeds'); }
    return new Response(JSON.stringify({ attachment_id: 'upload', upload_url: 'https://upload.example/image', required_headers: {} }), { headers: { 'content-type': 'application/json' } });
  } });
  const transport = new LinqMessenger(linq, repository(), async () => new Response(null, { status: 503 }));
  await assert.rejects(transport.send(randomUUID(), 'Here is your design', randomUUID(), [attachment()]), /MEDIA_UPLOAD_FAILED/);
  assert.equal(sends, 0);
});

test('visual context includes the newest photo and current design while excluding superseded renders', async () => {
  const ctx = context();
  const makeMessage = (seq: number, role: 'user' | 'assistant'): Message => ({ id: randomUUID(), seq: String(seq), conversation_id: ctx.conversation.id,
    role, sender: role === 'user' ? 'homeowner' : 'FORM', text: role === 'user' ? `Photo ${seq}` : 'Here is your design.', attachments: [attachment()], created_at: new Date(0) });
  const olderDesign = makeMessage(1, 'assistant');
  const photos = Array.from({ length: 6 }, (_, i) => makeMessage(i + 2, 'user'));
  const currentDesign = makeMessage(8, 'assistant');
  ctx.referenceMessages = [olderDesign, ...photos, currentDesign];
  ctx.messages = [{ ...makeMessage(9, 'user'), text: 'Use the last photo and make the cabinets lighter.', attachments: [] }];
  const labels: string[] = []; let images = 0;
  const client = modelClient((request) => {
    for (const item of request.input) if (Array.isArray(item.content)) for (const part of item.content) {
      if (part.type === 'input_image') images++;
      if (part.type === 'input_text') labels.push(part.text);
    }
    assert.match(request.input.at(-1).content[0].text, /make the cabinets lighter/);
  });
  await new OpenAIAgent(client, 'test', repository()).respond(ctx);
  assert.equal(images, 5);
  assert.ok(labels.some((label) => label.includes(photos[5]!.attachments[0]!.id)));
  assert.ok(labels.some((label) => label.includes(currentDesign.attachments[0]!.id)));
  assert.ok(!labels.some((label) => label.includes(olderDesign.attachments[0]!.id)));
});

test('proposal and procurement ask only the next missing field and never repeat known details', () => {
  for (const kind of ['proposal', 'procurement'] as const) {
    const output = decision({ reply: 'I have sent it to the team.', handoff: { kind, summary: 'Please quote this work' },
      brief: { ...decision().brief, propertyAddress: '123 Example St', scope: 'Kitchen redesign', contractorName: 'Sam' } });
    const result = validateDecision(output, context());
    assert.equal(result.handoff, null);
    assert.equal(result.reply, 'What is the homeowner’s name?');
    output.brief.homeownerName = 'Alex';
    assert.equal(validateDecision(output, context()).handoff?.kind, kind);
  }
});

test('blocked or duplicate handoffs cannot retain a claim that a new design was created', () => {
  const ctx = context();
  const output = decision({ reply: 'Here is the kitchen I just created.', handoff: { kind: 'design', summary: 'New kitchen' } });
  assert.equal(validateDecision(output, ctx).reply, 'What is the property address for this kitchen?');
  output.brief.propertyAddress = '123 Example St';
  ctx.handoffs.push({ id: randomUUID(), kind: 'design', summary: 'Design pending', status: 'open' });
  assert.match(validateDecision(output, ctx).reply!, /already with the team/);
});

test('image generation distinguishes current kitchen, inspiration, and the latest revision baseline', async () => {
  const ctx = context();
  const current = attachment(); const inspiration = attachment(); const baseline = attachment();
  ctx.messages = [
    { id: randomUUID(), seq: '1', conversation_id: ctx.conversation.id, role: 'user', sender: 'homeowner', text: 'Current room and inspiration', attachments: [current, inspiration], created_at: new Date() },
    { id: randomUUID(), seq: '2', conversation_id: ctx.conversation.id, role: 'assistant', sender: 'FORM', text: 'Design', attachments: [baseline], created_at: new Date() },
  ];
  const output = decision({ handoff: { kind: 'design', summary: 'Only lighten the cabinets' }, brief: { ...decision().brief, propertyAddress: '123 Example St', imageReferences: [
    { attachmentId: current.id, purpose: 'current_kitchen' }, { attachmentId: inspiration.id, purpose: 'inspiration' },
  ] } });
  assert.match(buildKitchenPrompt(ctx, output), /Only lighten the cabinets/);
  const client = { images: { async edit(body: { prompt: string; image: unknown[] }) {
    assert.equal(body.image.length, 3);
    assert.match(body.prompt, /Image 1: current_kitchen/);
    assert.match(body.prompt, /Image 2: inspiration/);
    assert.match(body.prompt, /Image 3: latest FORM design: revision baseline/);
    return { data: [{ b64_json: jpeg.toString('base64') }] };
  } } };
  await new OpenAIDesignStudio(client as never, 'test', repository()).generate(ctx, output);
});
