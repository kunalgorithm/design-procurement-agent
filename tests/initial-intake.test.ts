import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateDecision, type Message } from '../src/domain.js';
import { intakeQuestion } from '../src/intake.js';
import { context, decision, readyBrief } from './fixtures.js';

function readyContext() {
  const ctx = context(); ctx.conversation.brief = readyBrief();
  const question: Message = { id: randomUUID(), seq: '2', conversation_id: ctx.conversation.id, role: 'assistant', sender: 'FORM', text: intakeQuestion, attachments: [], created_at: new Date() };
  const answer: Message = { ...question, id: randomUUID(), seq: '3', role: 'user', sender: 'homeowner', text: 'Nothing else, go ahead.' };
  ctx.intakeCheckpoint = question; ctx.messages = [question, answer];
  return ctx;
}
const design = () => decision({ brief: readyBrief(), reply: 'Here is your design.', handoff: { kind: 'design', summary: 'More storage' } });

test('first design waits for a delivered checkpoint even with a complete brief', () => {
  for (const group of [true, false]) {
    const ctx = context(); ctx.conversation.is_group = group;
    const result = validateDecision(design(), ctx);
    assert.equal(result.handoff, null); assert.equal(result.intakeConfirmation?.action, 'ask');
    assert.ok(result.reply?.endsWith(intakeQuestion)); assert.doesNotMatch(result.reply!, /Here is your design/);
  }
});

test('premature design and checkpoint requests ask only the next missing input', () => {
  for (const action of ['design', 'ask']) {
    for (const [key, pattern] of [['currentKitchen', /current kitchen/], ['floorPlan', /floor plan/], ['preferences', /love to change/]] as const) {
      const out = design(); out.brief.intake![key] = 'pending';
      if (action === 'ask') { out.handoff = null; out.intakeConfirmation = { action: 'ask', messageId: null }; }
      const result = validateDecision(out, context());
      assert.equal(result.handoff, null); assert.equal(result.intakeConfirmation, null); assert.match(result.reply!, pattern);
    }
  }
  const ambiguous = design(); ambiguous.brief.imageReferences = [{ attachmentId: 'photo', purpose: 'unknown' }];
  assert.match(validateDecision(ambiguous, context()).reply!, /current space or.*inspiration/);
});

test('unavailable plans/photos and an open creative direction can reach the final question', () => {
  const out = design(); out.brief.intake = { currentKitchen: 'unavailable', floorPlan: 'unavailable', preferences: 'open' };
  assert.equal(validateDecision(out, context()).intakeConfirmation?.action, 'ask');
});

test('only a later real text reply to the delivered checkpoint starts the first design', () => {
  const ctx = readyContext(); const out = design();
  out.intakeConfirmation = { action: 'confirm', messageId: ctx.messages.at(-1)!.id };
  assert.equal(validateDecision(out, ctx).handoff?.kind, 'design');
  for (const mutate of [
    () => { ctx.intakeCheckpoint = null; },
    () => { out.intakeConfirmation!.messageId = randomUUID(); },
    () => { out.intakeConfirmation!.messageId = ctx.messages[0]!.id; },
    () => { ctx.messages.at(-1)!.seq = '1'; },
    () => { ctx.messages.at(-1)!.text = ''; },
    () => { ctx.intakeCheckpoint!.conversation_id = randomUUID(); },
    () => { ctx.conversation.brief.intake!.floorPlan = 'pending'; },
  ]) {
    const original = structuredClone(ctx); const originalOut = structuredClone(out);
    mutate(); assert.equal(validateDecision(out, ctx).handoff, null);
    Object.assign(ctx, original); Object.assign(out, originalOut);
  }
});

test('a photo anywhere after the checkpoint requires another final check', () => {
  const ctx = readyContext(); const out = design();
  ctx.messages.splice(1, 0, { ...ctx.messages.at(-1)!, id: randomUUID(), seq: '3', text: '', attachments: [
    { id: 'more', url: '/unavailable', filename: 'kitchen.jpg', mimeType: 'image/jpeg', sizeBytes: 4 },
  ] });
  ctx.messages.at(-1)!.seq = '4'; out.intakeConfirmation = { action: 'confirm', messageId: ctx.messages.at(-1)!.id };
  assert.equal(validateDecision(out, ctx).handoff, null);
  ctx.referenceMessages = ctx.messages.splice(1, 1);
  assert.equal(validateDecision(out, ctx).handoff, null, 'Older uploads remain relevant after the text history window rolls over');
});

test('later revisions do not repeat first-design intake and checkpoint retries keep one question', () => {
  const ctx = context(); ctx.designCount = 1;
  const out = decision({ brief: { ...decision().brief, propertyAddress: '123 Example Street' }, handoff: { kind: 'design', summary: 'Green cabinets' } });
  assert.equal(validateDecision(out, ctx).handoff?.kind, 'design');
  const first = validateDecision(design(), context());
  assert.equal(validateDecision(first, context()).reply, first.reply);
});
