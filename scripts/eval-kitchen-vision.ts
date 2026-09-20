// Opt-in real-model checks. No database writes, image generation, or message sends.
// Private fixtures stay outside git. Supply --photos PATH PATH or --linq-message ID.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import Linq from '@linqapp/sdk';
import { OpenAIAgent } from '../src/agent.js';
import { emptyBrief, type AgentContext, type Attachment, type Decision, type Message } from '../src/domain.js';
import { sniffImage } from '../src/media.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const agent = new OpenAIAgent(new OpenAI({ maxRetries: 0, timeout: 60000 }), model);
const args = process.argv.slice(2);
function attachment(bytes: Buffer, id: string): Attachment {
  const mimeType = sniffImage(bytes);
  if (!mimeType) throw new Error('Unsupported image fixture');
  return { id, url: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType, filename: 'photo', sizeBytes: bytes.length };
}
let lPhotos: Attachment[] = [];
if (args[0] === '--photos' && args.length > 1) {
  lPhotos = await Promise.all(args.slice(1).map(async (path, i) => attachment(await readFile(path), `current-${i + 1}`)));
} else if (args[0] === '--linq-message' && args.length === 2) {
  if (!process.env.LINQ_API_KEY) throw new Error('LINQ_API_KEY is required for message fixtures');
  const message = await new Linq({ apiKey: process.env.LINQ_API_KEY, maxRetries: 0 }).messages.retrieve(args[1]!);
  for (const part of message.parts ?? []) {
    if (part.type !== 'media' || !part.url) continue;
    const url = new URL(part.url);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.linqapp.com' || url.username || url.password) throw new Error('Unexpected fixture media host');
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error(`Fixture download failed: ${response.status}`);
    lPhotos.push(attachment(Buffer.from(await response.arrayBuffer()), `current-${lPhotos.length + 1}`));
  }
  if (!lPhotos.length) throw new Error('The fixture message has no readable images');
} else if (args.length) throw new Error('Usage: eval-kitchen-vision.ts [--photos PATH PATH | --linq-message ID]');
const uPhoto = attachment(await readFile(new URL('../public/kitchen-sample.jpg', import.meta.url)), 'u-example');
function setup(): AgentContext {
  return { conversation: { id: randomUUID(), external_id: randomUUID(), channel: 'sandbox', is_group: false, owner_handle: null,
    paused: false, brief: emptyBrief(), created_at: new Date(), updated_at: new Date() }, messages: [], handoffs: [], hasAssistantReply: true };
}
function append(ctx: AgentContext, role: Message['role'], text: string, attachments: Attachment[] = []) {
  ctx.messages.push({ id: randomUUID(), seq: String(ctx.messages.length + 1), conversation_id: ctx.conversation.id,
    role, sender: role === 'assistant' ? 'FORM' : 'homeowner', text, attachments, created_at: new Date() });
}
function expectLayout(out: Decision, shape: 'L-shaped' | 'U-shaped', runs: number, corners: number) {
  assert.equal(out.brief.kitchenLayout?.shape, shape);
  assert.equal(out.brief.kitchenLayout?.wallRuns.length, runs);
  assert.equal(out.brief.kitchenLayout?.connectedCorners, corners);
  assert.equal(out.handoff, null);
  assert.ok(out.brief.kitchenLayout?.wallRuns.every((run) => run.attachmentIds.length > 0));
}
const cases: { name: string; ctx: AgentContext; check: (out: Decision) => void }[] = [];
const u = setup(); append(u, 'user', 'Here is my current kitchen. What layout do you see?', [uPhoto]);
cases.push({ name: 'true_u_with_separate_island', ctx: u, check(out) { expectLayout(out, 'U-shaped', 3, 2); assert.equal(out.brief.kitchenLayout?.island, true); } });
if (lPhotos.length) {
  for (const [index, photos] of [lPhotos, [...lPhotos].reverse()].entries()) {
    const ctx = setup(); append(ctx, 'assistant', 'Could you send a few photos of your current kitchen?'); append(ctx, 'user', '', photos);
    cases.push({ name: `l_shape_photo_order_${index + 1}`, ctx, check(out) {
      expectLayout(out, 'L-shaped', 2, 1); assert.doesNotMatch(out.reply ?? '', /U[- ]shaped|full kitchen/i);
    } });
  }
  const mixed = setup(); append(mixed, 'user', 'These first photos show my current kitchen.', lPhotos);
  append(mixed, 'user', 'This last photo is inspiration only. I like the white cabinets, but keep my current layout.', [uPhoto]);
  cases.push({ name: 'inspiration_does_not_change_existing_shape', ctx: mixed, check(out) {
    expectLayout(out, 'L-shaped', 2, 1); assert.ok(out.brief.kitchenLayout?.wallRuns.every(run => !run.attachmentIds.includes(uPhoto.id)));
  } });
  const corrected = setup(); append(corrected, 'user', 'My current kitchen.', lPhotos);
  append(corrected, 'assistant', 'I can see the full U-shaped kitchen.');
  corrected.conversation.brief.constraints = ['Preserve the U-shaped layout'];
  append(corrected, 'user', 'Is that right? Please take another look at the photos.');
  cases.push({ name: 'reassess_wrong_prior_description', ctx: corrected, check(out) {
    expectLayout(out, 'L-shaped', 2, 1); assert.doesNotMatch(out.brief.constraints.join(' '), /U[- ]shaped/i);
  } });
}
const missing = setup(); append(missing, 'user', 'What layout do you see?', [{ ...uPhoto, url: 'https://cdn.linqapp.com/unavailable.jpg' }]);
missing.messages[0]!.created_at = new Date(0);
cases.push({ name: 'unavailable_image_is_not_visual_evidence', ctx: missing, check(out) {
  assert.ok(!out.brief.kitchenLayout || out.brief.kitchenLayout.shape === 'unknown');
  assert.doesNotMatch(out.reply ?? '', /(?:L|U)[- ]shaped/);
} });
let failures = 0;
for (const scenario of cases) {
  const started = Date.now();
  try {
    const out = await agent.respond(scenario.ctx); scenario.check(out);
    console.log(JSON.stringify({ scenario: scenario.name, pass: true, model, elapsedMs: Date.now() - started, reply: out.reply, layout: out.brief.kitchenLayout }));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ scenario: scenario.name, pass: false, elapsedMs: Date.now() - started,
      errorType: error instanceof Error ? error.name : 'UnknownError', error: error instanceof assert.AssertionError ? error.message : 'MODEL_REQUEST_FAILED',
      ...(error instanceof OpenAI.APIError ? { status: error.status, code: error.code } : {}) }));
  }
}
console.log(JSON.stringify({ evaluation: 'kitchen_vision', passed: cases.length - failures, failures }));
process.exitCode = failures ? 1 : 0;
