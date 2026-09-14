import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { designReview, decisionSchema, identifiedSenderRole, participantContext, validateDecision, type AgentContext, type Attachment, type Message } from '../src/domain.js';
import { context, decision } from './fixtures.js';

const image: Attachment = { id: 'delivered-design', url: '/api/media/design', mimeType: 'image/jpeg', filename: 'design.jpg', sizeBytes: 10 };
function message(ctx: AgentContext, seq: number, role: Message['role'], text: string, attachments: Attachment[] = []): Message {
  return { id: randomUUID(), conversation_id: ctx.conversation.id, seq: String(seq), role, sender: role === 'assistant' ? 'FORM' : '+12025550101', text, attachments, created_at: new Date() };
}
function reviewContext() {
  const ctx = context(); ctx.conversation.is_group = false;
  ctx.messages = [message(ctx, 1, 'assistant', 'Here is your kitchen.', [image]), message(ctx, 2, 'user', 'Finalize this design.')];
  return ctx;
}
function approve(ctx: AgentContext) {
  return decision({ reply: 'Your design is finalized.', handoff: { kind: 'finalization', summary: 'Dark cabinets; retain backsplash.' },
    approval: { designAttachmentId: image.id, customerMessageId: ctx.messages[1]!.id } });
}

test('finalization binds a delivered image and current customer approval without name intake', () => {
  const ctx = reviewContext();
  const output = validateDecision(approve(ctx), ctx);
  assert.equal(output.handoff?.kind, 'finalization');
  assert.equal(output.brief.homeownerName, null);
  assert.equal(output.brief.contractorName, null);
  // A burst ending in thanks still includes the explicit approval.
  ctx.messages.push(message(ctx, 3, 'user', 'Thanks!'));
  assert.equal(validateDecision(approve(ctx), ctx).handoff?.kind, 'finalization');
});

test('finalization rejects missing, foreign, stale, contractor, and pre-render approval evidence', () => {
  for (const change of [
    (ctx: AgentContext) => { ctx.messages[0]!.attachments = []; },
    (ctx: AgentContext) => { ctx.messages[1]!.role = 'operator'; },
    (ctx: AgentContext) => { ctx.messages[1]!.sender = 'contractor'; },
    (ctx: AgentContext) => { ctx.messages[1]!.seq = '0'; },
    (ctx: AgentContext) => { ctx.messages.push(message(ctx, 3, 'assistant', 'Would you like to finalize?')); },
  ]) {
    const ctx = reviewContext(); change(ctx);
    assert.equal(validateDecision(approve(ctx), ctx).handoff, null);
  }
  const ctx = reviewContext();
  const output = approve(ctx);
  output.approval!.customerMessageId = randomUUID();
  assert.equal(validateDecision(output, ctx).handoff, null);
  output.approval!.customerMessageId = ctx.messages[1]!.id;
  output.approval!.designAttachmentId = 'older-or-foreign-design';
  assert.equal(validateDecision(output, ctx).handoff, null);
  output.approval = null;
  assert.equal(validateDecision(output, ctx).handoff, null);
});

test('review state survives truncated history and completed contractor work without repeated finalization', () => {
  const ctx = reviewContext();
  ctx.referenceMessages = [ctx.messages[0]!]; ctx.messages = [ctx.messages[1]!]; ctx.designCount = 4;
  ctx.finalizedDesign = { id: randomUUID(), kind: 'finalization', summary: 'Approved', status: 'completed', design_approval: {
    design: image, customerMessageId: ctx.messages[0]!.id, customerSender: ctx.messages[0]!.sender,
    customerText: ctx.messages[0]!.text, approvedAt: new Date().toISOString(), brief: decision().brief,
  } };
  assert.equal(designReview(ctx).count, 4);
  assert.ok(designReview(ctx).finalized);
  assert.match(participantContext(ctx), /"finalized":true/);
  const output = decision({ handoff: { kind: 'finalization', summary: 'Again' } });
  assert.equal(validateDecision(output, ctx).handoff, null);
  ctx.finalizedDesign.status = 'superseded';
  assert.equal(designReview(ctx).finalized, null);
});

test('pilot DMs get customer context while unlabeled group roles remain unresolved', () => {
  const ctx = reviewContext();
  assert.match(participantContext(ctx), /treat the person texting FORM as the homeowner\/customer/);
  ctx.conversation.is_group = true;
  assert.doesNotMatch(participantContext(ctx), /direct-message pilot/);
  assert.equal(validateDecision(approve(ctx), ctx).handoff, null);
  const identity = message(ctx, 0, 'user', 'I’m the homeowner.');
  ctx.messages.unshift(identity);
  assert.equal(identifiedSenderRole(ctx, identity.sender), 'homeowner');
  const output = approve(ctx); output.approval!.customerMessageId = ctx.messages[2]!.id;
  assert.equal(validateDecision(output, ctx).handoff?.kind, 'finalization');
  identity.text = 'The homeowner said finalize it.';
  assert.equal(identifiedSenderRole(ctx, identity.sender), null);
  identity.text = 'I’m the contractor.';
  ctx.conversation.is_group = false;
  assert.equal(validateDecision(output, ctx).handoff, null);
});

test('legacy decisions remain readable and non-finalization cannot carry approval', () => {
  const old = decision(); delete old.approval;
  assert.deepEqual(decisionSchema.parse(old), old);
  const ctx = reviewContext(); const output = approve(ctx); output.handoff = null;
  assert.equal(validateDecision(output, ctx).approval, null);
});
