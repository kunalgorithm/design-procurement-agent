import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Linq from '@linqapp/sdk';
import { LinqMessenger } from '../src/linq.js';
import { contractorMatches, type RegisteredContractor } from '../src/group-contractors.js';
import { identifiedSenderRole, participantContext, validateDecision } from '../src/domain.js';
import { contractorSignupSchema } from '../src/contractor-schema.js';
import { context, decision } from './fixtures.js';

const contractor: RegisteredContractor = { id: randomUUID(), phone: '+12025550101', firstName: 'Sam', lastName: 'Rivera', businessName: 'Example Kitchens', website: null };

test('identical repeated signups resolve once; conflicting identities remain ambiguous', () => {
  assert.deepEqual(contractorMatches([contractor, { ...contractor, id: randomUUID() }]).contractors, [contractor]);
  const conflict = contractorMatches([contractor, { ...contractor, firstName: 'Someone else' }]);
  assert.equal(conflict.contractors.length, 0);
  assert.deepEqual(conflict.ambiguousPhones, [contractor.phone]);
  assert.equal(contractorMatches([{ ...contractor, phone: 'sam+12025550101@example.com' }]).contractors.length, 0);
});

test('registered group sender role overrides contradictory text, without identifying other people', () => {
  const ctx = context(); ctx.registeredContractors = [contractor];
  ctx.conversation.participant_roles = { [contractor.phone]: 'homeowner' };
  assert.equal(identifiedSenderRole(ctx, '+1 (202) 555-0101'), 'contractor');
  assert.equal(identifiedSenderRole(ctx, '+12025550102'), null);
  assert.equal(identifiedSenderRole(ctx, 'sam@example.com'), null);
  const prompt = participantContext(ctx);
  assert.match(prompt, /Sam/); assert.match(prompt, /Example Kitchens/);
  assert.match(prompt, /not automatically homeowners/);
  assert.match(prompt, /"\+12025550101" is the contractor/);
  const validated = validateDecision(decision({ brief: { ...decision().brief, contractorName: 'Invented' } }), ctx);
  assert.equal(validated.brief.contractorName, 'Sam Rivera');
});

test('a missing practice remains unknown and multiple contractors do not select a lead', () => {
  const ctx = context(); ctx.registeredContractors = [{ ...contractor, businessName: null }];
  assert.match(participantContext(ctx), /"businessName":null/);
  ctx.registeredContractors.push({ ...contractor, id: randomUUID(), phone: '+12025550103', firstName: 'Alex' });
  assert.match(participantContext(ctx), /which contractor is leading/);
  assert.equal(validateDecision(decision(), ctx).brief.contractorName, null);
  ctx.conversation.contractor_signup_id = contractor.id;
  assert.equal(validateDecision(decision(), ctx).brief.contractorName, 'Sam Rivera');
  ctx.registeredContractors = ctx.registeredContractors.slice(1);
  assert.equal(validateDecision(decision({ brief: { ...decision().brief, contractorName: 'Sam Rivera' } }), ctx).brief.contractorName, 'Sam Rivera');
});

test('signup accepts a practice while remaining compatible with existing submissions', () => {
  const payload = { submissionId: randomUUID(), firstName: 'Sam', lastName: 'Rivera', phone: '2025550101', email: 'test@example.com' };
  assert.equal(contractorSignupSchema.parse(payload).businessName, undefined);
  assert.equal(contractorSignupSchema.parse({ ...payload, businessName: ' Example Kitchens ' }).businessName, 'Example Kitchens');
  assert.equal(contractorSignupSchema.safeParse({ ...payload, businessName: 'x'.repeat(151) }).success, false);
});

test('Linq roster includes silent members, excludes owned/removed handles, and preserves Apple ID emails', async () => {
  const id = randomUUID();
  const handles = [
    { handle: '+12025550100', is_me: true }, { handle: contractor.phone },
    { handle: 'homeowner@example.com' }, { handle: '+12025550103', left_at: '2026-09-14T12:00:00Z' },
    { handle: '+12025550104', status: 'removed' },
  ];
  const client = new Linq({ apiKey: 'test', maxRetries: 0, fetch: async (url) => {
    assert(String(url).endsWith(`/chats/${id}`));
    return new Response(JSON.stringify({ id, is_group: true, handles }), { headers: { 'content-type': 'application/json' } });
  } });
  const messenger = new LinqMessenger(client);
  assert.deepEqual(await messenger.chatParticipants(id, '+12025550100'), {
    handles: [contractor.phone, 'homeowner@example.com'], owner: '+12025550100', isGroup: true,
  });
  await assert.rejects(() => messenger.chatParticipants(id, '+12025550999'), /CHAT_OWNER_MISMATCH/);
});

test('contractor DMs receive signup identity instead of the customer default, including existing chats', () => {
  const ctx = context(); ctx.conversation.is_group = false; ctx.hasAssistantReply = true;
  ctx.registeredContractors = [{ ...contractor, businessName: null }];
  ctx.conversation.participant_roles = { [contractor.phone]: 'homeowner' };
  assert.equal(identifiedSenderRole(ctx, contractor.phone), 'contractor');
  const prompt = participantContext(ctx);
  assert.match(prompt, /Sam/); assert.match(prompt, /registered contractor/); assert.match(prompt, /correct that assumption/);
  assert.match(prompt, /"businessName":null/); assert.doesNotMatch(prompt, /treat the person texting FORM as the homeowner/);
  ctx.registeredContractors = [];
  assert.match(participantContext(ctx), /treat the person texting FORM as the homeowner\/customer/);
});

test('private client selection overrides signup only for its bound sender and session', () => {
  const ctx = context(); ctx.conversation.is_group = false;
  ctx.conversation.role_override = 'homeowner'; ctx.conversation.role_override_sender = contractor.phone;
  ctx.registeredContractors = [contractor];
  assert.equal(identifiedSenderRole(ctx, '+1 (202) 555-0101'), 'homeowner');
  assert.equal(identifiedSenderRole(ctx, '+12025550102'), null);
  assert.equal(identifiedSenderRole(ctx, 'sam@example.com'), null);
  assert.equal(validateDecision(decision(), ctx).brief.contractorName, null);
  assert.doesNotMatch(participantContext(ctx), /Sam|Example Kitchens/);
  ctx.conversation.is_group = true;
  assert.equal(identifiedSenderRole(ctx, contractor.phone), 'contractor');
  assert.equal(validateDecision(decision(), ctx).brief.contractorName, 'Sam Rivera');
  ctx.conversation.is_group = false; ctx.conversation.channel = 'sandbox'; ctx.registeredContractors = [];
  assert.equal(identifiedSenderRole(ctx, contractor.phone), null);
});

test('first private contractor replies skip introductions but group client replies still introduce FORM', () => {
  const ctx = context(); ctx.registeredContractors = [contractor]; ctx.hasAssistantReply = false;
  ctx.conversation.is_group = false;
  assert.match(participantContext(ctx), /Do not introduce yourself to the contractor/);
  assert.doesNotMatch(participantContext(ctx), /Introduce yourself in your first text reply/);
  ctx.conversation.is_group = true;
  assert.match(participantContext(ctx), /Introduce FORM to the client/);
  assert.match(participantContext(ctx), /Introduce yourself in your first text reply/);
});
