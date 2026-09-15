// Opt-in real-model dialogue test; no app writes, image generation, or Linq messages.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { OpenAIAgent } from '../src/agent.js';
import { emptyBrief, validateDecision, type AgentContext, type Attachment, type Decision, type Message } from '../src/domain.js';
import { intakeQuestion } from '../src/intake.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const agent = new OpenAIAgent(new OpenAI({ maxRetries: 0, timeout: 60000 }), process.env.OPENAI_MODEL || 'gpt-5.6-terra');
const bytes = await readFile(new URL('../public/kitchen-sample.jpg', import.meta.url));
const photo: Attachment = { id: 'current-kitchen', url: `data:image/jpeg;base64,${bytes.toString('base64')}`, mimeType: 'image/jpeg', filename: 'photo.jpg', sizeBytes: bytes.length };
function setup(group = false): AgentContext {
  return { conversation: { id: randomUUID(), external_id: randomUUID(), channel: 'linq', is_group: group,
    owner_handle: '+12025550100', paused: false, brief: emptyBrief(), created_at: new Date(), updated_at: new Date() },
    messages: [], handoffs: [], designCount: 0, intakeCheckpoint: null,
    ...(group ? { registeredContractors: [{ id: randomUUID(), phone: '+12025550101', firstName: 'Sam', lastName: 'Rivera', businessName: 'Example Kitchens', website: null }] } : {}) };
}
function append(ctx: AgentContext, role: Message['role'], text: string, attachments: Attachment[] = []) {
  const message: Message = { id: randomUUID(), seq: String(ctx.messages.length + 1), conversation_id: ctx.conversation.id,
    role, sender: role === 'assistant' ? 'FORM' : '+12025550102', text, attachments, created_at: new Date() };
  ctx.messages.push(message); return message;
}
let failures = 0; let checks = 0;
async function step(ctx: AgentContext, name: string, text: string, attachments: Attachment[], check: (out: Decision) => void) {
  append(ctx, 'user', text, attachments);
  try {
    const raw = await agent.respond(ctx); const out = validateDecision(raw, ctx);
    // Check the raw model, too, so a fallback cannot disguise a dialogue regression.
    assert.equal(raw.handoff?.kind ?? null, out.handoff?.kind ?? null);
    check(out); checks++;
    console.log(JSON.stringify({ scenario: name, pass: true, reply: out.reply, intake: out.brief.intake, confirmation: out.intakeConfirmation?.action, handoff: out.handoff?.kind }));
    ctx.conversation.brief = out.brief;
    const reply = out.reply ? append(ctx, 'assistant', out.reply) : null;
    ctx.intakeCheckpoint = out.intakeConfirmation?.action === 'ask' ? reply : null;
    ctx.hasAssistantReply = !!reply || ctx.hasAssistantReply;
    return out;
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ scenario: name, pass: false, error: error instanceof assert.AssertionError ? error.message : 'MODEL_REQUEST_FAILED',
      ...(error instanceof OpenAI.APIError ? { status: error.status, code: error.code } : {}) }));
    throw error;
  }
}
const waiting = (out: Decision) => assert.equal(out.handoff, null);
const checkpoint = (out: Decision) => { waiting(out); assert.equal(out.intakeConfirmation?.action, 'ask'); assert.ok(out.reply?.endsWith(intakeQuestion)); };
const dm = setup();
try {
  await step(dm, 'current_photo_asks_for_plan', 'These are photos of my current kitchen at 123 Example Street.', [photo], (out) => {
    waiting(out); assert.equal(out.brief.intake?.currentKitchen, 'provided'); assert.match(out.reply!, /floor plan|floorplan|sketch/i);
    assert.doesNotMatch(out.reply!, /is this.*(?:current|inspiration)|are these.*(?:current|inspiration)/i);
  });
  await step(dm, 'plan_is_still_coming', 'I have a floor plan somewhere. Give me a minute to find it.', [], (out) => {
    waiting(out); assert.equal(out.brief.intake?.floorPlan, 'pending'); assert.equal(out.intakeConfirmation, null);
  });
  await step(dm, 'no_plan_moves_to_preferences', 'I can’t find it, so let’s go without the floor plan.', [], (out) => {
    waiting(out); assert.equal(out.brief.intake?.floorPlan, 'unavailable'); assert.match(out.reply!, /style|color|feel|storage|change|goal|look|vibe/i);
  });
  await step(dm, 'goals_reach_checkpoint', 'I want more storage and a warm sage-green feel, with light counters.', [], checkpoint);
  await step(dm, 'extra_upload_requires_fresh_checkpoint', 'Here is another picture of our current kitchen. Keep the window.', [{ ...photo, id: 'extra-current' }], checkpoint);
  await step(dm, 'yes_more_coming_is_not_readiness', 'Yes, one more thing. I’m still collecting my ideas—please wait.', [], (out) => { waiting(out); assert.equal(out.intakeConfirmation, null); });
  await step(dm, 'new_details_then_another_final_check', 'Brass handles too. Those are all my ideas.', [], checkpoint);
  await step(dm, 'nothing_else_allows_first_design', 'Nothing else, go ahead.', [], (out) => {
    assert.equal(out.handoff?.kind, 'design'); assert.equal(out.intakeConfirmation?.action, 'confirm'); assert.doesNotMatch(out.reply!, /finaliz/i);
  });
} catch { /* One failed step stops only its dependent conversation. */ }
const group = setup(true);
try {
  await step(group, 'complete_group_brief_still_waits', 'Hi, I’m Sarah, the homeowner. Sam is my contractor. This is my current kitchen at 123 Example Street. I don’t have a plan. I want warm oak and more storage. Please make a design.', [photo], (out) => {
    checkpoint(out); assert.match(out.reply!, /Sam/); assert.match(out.reply!, /Example Kitchens/); assert.match(out.reply!, /oak|storage/i);
  });
  await step(group, 'group_ready', 'No, that’s everything. Go ahead!', [], (out) => assert.equal(out.handoff?.kind, 'design'));
} catch { /* Reported above. */ }
try {
  await step(setup(), 'inspiration_alone_asks_for_current_space', 'I like this inspiration kitchen. Our address is 123 Example Street.', [{ ...photo, id: 'inspiration' }], (out) => {
    waiting(out); assert.equal(out.brief.intake?.currentKitchen, 'pending'); assert.equal(out.brief.imageReferences?.[0]?.purpose, 'inspiration'); assert.match(out.reply!, /current|existing|your (?:own |actual )?kitchen/i);
  });
} catch { /* Reported above. */ }
console.log(JSON.stringify({ evaluation: 'initial_intake', passed: checks, failures }));
process.exitCode = failures ? 1 : 0;
