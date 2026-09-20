import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { OpenAIAgent } from '../src/agent.js';
import { buildKitchenPrompt } from '../src/design.js';
import { decisionSchema, modelDecisionSchema, type Attachment, type Message } from '../src/domain.js';
import { context, decision } from './fixtures.js';

const photo = (id: string): Attachment => ({ id, url: 'data:image/jpeg;base64,/9j/AA', filename: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 4 });
function client(inspect: (body: any) => void) {
  return new OpenAI({ apiKey: 'test', maxRetries: 0, fetch: async (_url, init) => {
    inspect(JSON.parse(String(init?.body)));
    return Response.json({ id: 'resp_test', object: 'response', status: 'completed', output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify(decision()), annotations: [] }] }] });
  } });
}

test('visual input budget retains two current-room views, a plan, the latest upload, and latest design', async () => {
  const ctx = context();
  const files = ['sink-view', 'range-view', 'plan', 'style-1', 'style-2', 'style-3', 'style-4'];
  ctx.referenceMessages = files.map((id, i): Message => ({ id: randomUUID(), seq: String(i + 1), conversation_id: ctx.conversation.id,
    role: 'user', sender: 'homeowner', text: id, attachments: [photo(id)], created_at: new Date() }));
  ctx.referenceMessages.push({ ...ctx.referenceMessages[0]!, id: randomUUID(), seq: '8', role: 'assistant', sender: 'FORM', text: 'Design', attachments: [photo('design')] });
  ctx.messages = [{ ...ctx.referenceMessages[0]!, id: randomUUID(), seq: '9', text: 'Use that style in my kitchen', attachments: [] }];
  ctx.conversation.brief.imageReferences = files.map((id) => ({ attachmentId: id,
    purpose: id.endsWith('view') ? 'current_kitchen' : id === 'plan' ? 'floor_plan' : 'inspiration' }));
  await new OpenAIAgent(client((body) => {
    const labels = body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
      .filter((part: any) => part.type === 'input_text').map((part: any) => part.text).join('\n');
    for (const id of ['sink-view', 'range-view', 'plan', 'style-4', 'design']) assert.ok(labels.includes(`attachment ID: ${id};`));
    for (const id of ['style-1', 'style-2', 'style-3']) assert.ok(!labels.includes(`attachment ID: ${id};`));
    assert.equal(body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content : []).filter((part: any) => part.type === 'input_image').length, 5);
    assert.equal(body.reasoning.effort, 'high');
    assert.equal(body.max_output_tokens, 8000);
    assert.match(body.input[1].content, /Visual inputs actually attached/);
  }), 'gpt-5.6-terra').respond(ctx);
});

test('unavailable photos are explicitly excluded from visual evidence and do not trigger visual reasoning', async () => {
  const ctx = context();
  ctx.messages = [{ id: randomUUID(), seq: '1', conversation_id: ctx.conversation.id, role: 'user', sender: 'homeowner', text: 'What shape is this?',
    attachments: [{ ...photo('expired'), url: 'https://cdn.linqapp.com/expired.jpg' }], created_at: new Date(0) }];
  await new OpenAIAgent(client((body) => {
    assert.match(body.input[1].content, /actually attached on this turn: \[\]/);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.max_output_tokens, 5000);
    assert.ok(body.input.every((item: any) => !Array.isArray(item.content) || item.content.every((part: any) => part.type !== 'input_image')));
  }), 'gpt-5.6-terra').respond(ctx);
});

test('inline image bytes are sent only as visual input, never duplicated into text metadata', async () => {
  const ctx = context(); const image = photo('current');
  ctx.messages = [{ id: randomUUID(), seq: '1', conversation_id: ctx.conversation.id, role: 'user', sender: 'homeowner', text: 'Current kitchen',
    attachments: [image], created_at: new Date() }];
  await new OpenAIAgent(client((body) => {
    const parts = body.input.flatMap((item: any) => Array.isArray(item.content) ? item.content : []);
    assert.equal(parts.find((part: any) => part.type === 'input_image').image_url, image.url);
    const text = parts.filter((part: any) => part.type === 'input_text').map((part: any) => part.text).join('\n');
    assert.doesNotMatch(text, /base64|data:image/);
    assert.match(text, /"id":"current"/);
  }), 'gpt-5.6-terra').respond(ctx);
});

test('layout evidence is retained in the design request with uncertainty and existing-room restrictions', () => {
  const output = decision();
  output.brief.kitchenLayout = { wallRuns: [
    { description: 'Sink under window, dishwasher alongside', attachmentIds: ['sink-view'] },
    { description: 'Range and refrigerator on adjoining wall', attachmentIds: ['sink-view', 'range-view'] },
  ], connectedCorners: 1, shape: 'L-shaped', confidence: 'tentative', island: null, peninsula: null,
  limitations: ['Doorway side is not fully visible'] };
  const prompt = buildKitchenPrompt(context(), output);
  assert.match(prompt, /L-shaped/);
  assert.match(prompt, /Sink under window/);
  assert.match(prompt, /Doorway side is not fully visible/);
  assert.match(prompt, /explicit customer corrections take precedence/);
  assert.match(prompt, /Do not count the same cabinet run twice/);
});

test('old project briefs remain readable and new model decisions record geometry before the reply', () => {
  const old = decision(); delete old.brief.kitchenLayout;
  assert.deepEqual(decisionSchema.parse(old), old);
  assert.equal(Object.keys(modelDecisionSchema.shape)[0], 'brief');
  assert.equal(Object.keys(modelDecisionSchema.shape.brief.shape)[0], 'kitchenLayout');
  assert.throws(() => modelDecisionSchema.parse(old));
  assert.doesNotThrow(() => modelDecisionSchema.parse(decision()));
});
