// Opt-in live-model smoke test. Uses synthetic conversations and the public sample photo;
// never writes application data, generates images, or sends messages through Linq.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { OpenAIAgent } from '../src/agent.js';
import { designReview, emptyBrief, validateDecision, type AgentContext, type Attachment, type Decision, type Message } from '../src/domain.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for this opt-in evaluation');
const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra';
const agent = new OpenAIAgent(new OpenAI({ maxRetries: 0, timeout: 60000 }), model);
const bytes = await readFile(new URL('../public/kitchen-sample.jpg', import.meta.url));
const sample: Attachment = { id: 'sample-kitchen', url: `data:image/jpeg;base64,${bytes.toString('base64')}`, mimeType: 'image/jpeg', filename: 'kitchen.jpg', sizeBytes: bytes.length };

function append(ctx: AgentContext, role: Message['role'], text: string, sender = role === 'assistant' ? 'FORM' : '+12025550101', attachments: Attachment[] = []) {
  ctx.messages.push({ id: randomUUID(), conversation_id: ctx.conversation.id, seq: String(ctx.messages.length + 1), role, sender, text, attachments, created_at: new Date() });
}
function setup(count: number, text: string, question = 'What do you think? Let me know if you would like any changes.') {
  const ctx: AgentContext = { conversation: { id: randomUUID(), external_id: randomUUID(), channel: 'linq', is_group: false,
    owner_handle: null, paused: false, brief: { ...emptyBrief(), propertyAddress: '123 Example Street', scope: 'Kitchen redesign', materials: ['Existing light backsplash'], imageReferences: [{ attachmentId: sample.id, purpose: 'current_kitchen' }] }, created_at: new Date(), updated_at: new Date() }, messages: [], handoffs: [], hasAssistantReply: true, designCount: count };
  append(ctx, 'user', 'This is my current kitchen at 123 Example Street. Keep my light backsplash and layout.', undefined, [sample]);
  append(ctx, 'assistant', 'Thanks for sharing your kitchen.');
  for (let i = 0; i < count; i++) append(ctx, 'assistant', `Here is your kitchen design. ${question}`, undefined, [{ ...sample, id: `design-${i}` }]);
  append(ctx, 'user', text);
  return ctx;
}
const finalizeQuestion = 'Would you like to finalize this design so your contractor can order materials and plan the work?';
const cases: { name: string; context: AgentContext; kind: string | null; check?: (decision: Decision) => void }[] = [];
const add = (name: string, context: AgentContext, kind: string | null, check?: (decision: Decision) => void) => cases.push({ name, context, kind, check });
add('first_design_invites_feedback', setup(0, 'Please show me dark cabinets with my existing backsplash.'), 'design', (out) => {
  assert.match(out.reply ?? '', /what do you think|thoughts|changes/i); assert.doesNotMatch(out.reply ?? '', /finaliz/i);
});
add('revision_offers_finalize', setup(1, 'Make the cabinets dark navy, keep everything else.'), 'design', (out) => assert.match(out.reply ?? '', /finaliz|ready.*move forward/i));
add('casual_praise_is_not_approval', setup(1, 'Looks nice.'), null);
add('yes_to_feedback_is_not_approval', setup(1, 'Yes!'), null);
add('yes_to_finalize_is_approval', setup(2, 'Yes, please.', finalizeQuestion), 'finalization');
add('explicit_approval_no_name_intake', setup(1, 'This is the one. Finalize the design.'), 'finalization');
add('conditional_approval_means_revision', setup(2, 'Yes, but change the handles to brass first.', finalizeQuestion), 'design');
add('customer_can_take_time', setup(2, 'I need a few days to think. Please stop asking me to finalize.', finalizeQuestion), null, (out) => assert.doesNotMatch(out.reply ?? '', /\?|would you like|ready to/i));
const finished = setup(2, 'Thanks!', finalizeQuestion);
finished.finalizedDesign = { id: randomUUID(), kind: 'finalization', summary: 'Customer finalized the latest design.', status: 'open', design_approval: {
  design: designReview(finished).attachment!, customerMessageId: randomUUID(), customerSender: '+12025550101', customerText: 'Finalize it.', approvedAt: new Date().toISOString(), brief: finished.conversation.brief,
} };
append(finished, 'assistant', 'Your design is finalized! Your choices are saved for your contractor.');
append(finished, 'user', 'Thanks!');
add('finished_does_not_restart', finished, null, (out) => assert.doesNotMatch(out.reply ?? '', /\?|would you like|send.*photos|property address/i));
const contractor = setup(2, 'Finalize it.', finalizeQuestion); contractor.conversation.is_group = true; contractor.conversation.channel = 'sandbox'; contractor.messages.at(-1)!.sender = 'contractor';
add('contractor_cannot_approve_for_customer', contractor, null);
const group = setup(2, 'I love it. Finalize this version.', finalizeQuestion); group.conversation.is_group = true; group.conversation.channel = 'sandbox'; group.messages.at(-1)!.sender = 'homeowner'; group.conversation.brief.contractorName = 'Sam';
add('group_customer_returns_to_contractor', group, 'finalization', (out) => assert.match(out.reply ?? '', /Sam|contractor/i));
const unknown = setup(2, 'Finalize this.', finalizeQuestion); unknown.conversation.is_group = true; unknown.messages[0]!.text = 'The kitchen is at 123 Example Street.';
add('unidentified_group_approver_needs_role', unknown, null);
const identified = setup(2, 'Finalize this.', finalizeQuestion); identified.conversation.is_group = true;
identified.conversation.participant_roles = { '+12025550101': 'homeowner' };
add('identified_linq_customer_can_finalize', identified, 'finalization');
const contractorDm = setup(2, 'I am the contractor. Finalize this for my client.', finalizeQuestion);
add('contractor_dm_overrides_customer_default', contractorDm, null);
const burst = setup(2, 'Yes, finalize it.', finalizeQuestion); append(burst, 'user', 'Wait, make the cabinets navy first.');
add('later_burst_change_overrides_approval', burst, 'design');

let failures = 0;
// Two independent conversations at a time keep this bounded without flooding the API.
for (let i = 0; i < cases.length; i += 2) {
  await Promise.all(cases.slice(i, i + 2).map(async (scenario) => {
    let result: Decision | undefined;
    try {
      const raw = await agent.respond(scenario.context);
      result = validateDecision(raw, scenario.context);
      assert.equal(raw.handoff?.kind ?? null, scenario.kind);
      assert.equal(result.handoff?.kind ?? null, scenario.kind);
      if (scenario.kind === 'finalization') assert.ok(result.approval);
      else assert.equal(result.approval, null);
      assert.doesNotMatch(result.reply ?? '', /ask for a person|human support|human agent/i);
      assert.ok((result.reply ?? '').split(/\s+/).length <= 95);
      scenario.check?.(result);
      console.log(JSON.stringify({ scenario: scenario.name, pass: true, reply: result.reply, handoff: result.handoff?.kind ?? null }));
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ scenario: scenario.name, pass: false, reply: result?.reply, handoff: result?.handoff?.kind ?? null,
        error: error instanceof assert.AssertionError ? error.message : 'MODEL_REQUEST_FAILED' }));
    }
  }));
}
console.log(JSON.stringify({ model, scenarios: cases.length, failures }));
process.exitCode = failures ? 1 : 0;
