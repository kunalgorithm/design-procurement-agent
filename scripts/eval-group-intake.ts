// Synthetic, opt-in model evaluation. Does not write app data or send Linq texts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { OpenAIAgent } from '../src/agent.js';
import { emptyBrief, validateDecision, type AgentContext } from '../src/domain.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const agent = new OpenAIAgent(new OpenAI({ maxRetries: 0, timeout: 60000 }), process.env.OPENAI_MODEL || 'gpt-5.6-terra');
const contractor = { id: randomUUID(), phone: '+12025550101', firstName: 'Sam', lastName: 'Rivera', businessName: 'Example Kitchens', website: null };
const cases = [
  { name: 'contractor_introduces_homeowner', sender: contractor.phone, text: 'This is Sarah, the homeowner. We are redoing her kitchen. She wants warm oak cabinets.', replied: false, business: contractor.businessName },
  { name: 'homeowner_speaks_first', sender: '+12025550102', text: 'Hi, I’m Sarah, the homeowner. Sam is here with me. Our kitchen is at 123 Example Street, and I want more storage.', replied: false, business: contractor.businessName },
  { name: 'missing_practice_and_known_address', sender: contractor.phone, text: 'Sarah’s kitchen is at 123 Example Street. Can you help her with a design?', replied: false, business: null },
  { name: 'remembered_details_and_correction', sender: contractor.phone, text: 'Correction: the width is 13 feet, not 12. Sarah wants sage green cabinets now.', replied: true, business: contractor.businessName },
];
let failures = 0;
for (const scenario of cases) {
  const id = randomUUID();
  const ctx: AgentContext = {
    conversation: { id, external_id: randomUUID(), channel: 'linq', is_group: true, owner_handle: '+12025550100', paused: false,
      contractor_signup_id: contractor.id, participant_handles: [contractor.phone, '+12025550102'],
      brief: { ...emptyBrief(), ...(scenario.replied ? { homeownerName: 'Sarah', propertyAddress: '123 Example Street', reportedMeasurements: '12 feet', style: 'oak cabinets' } : {}) },
      created_at: new Date(), updated_at: new Date() },
    registeredContractors: [{ ...contractor, businessName: scenario.business }], handoffs: [], hasAssistantReply: scenario.replied,
    messages: [
      ...(scenario.replied ? [{ id: randomUUID(), seq: '1', conversation_id: id, role: 'assistant' as const, sender: 'FORM', text: 'Hi, I’m FORM, working with Sam. Could you send the kitchen photos?', attachments: [], created_at: new Date() }] : []),
      { id: randomUUID(), seq: '2', conversation_id: id, role: 'user', sender: scenario.sender, text: scenario.text, attachments: [], created_at: new Date() },
    ],
  };
  try {
    const out = validateDecision(await agent.respond(ctx), ctx);
    assert.equal(out.brief.contractorName, 'Sam Rivera');
    assert.doesNotMatch(out.reply ?? '', /what(?:’s| is) your (?:name|company)|are you (?:the |a )?contractor/i);
    if (!scenario.replied) { assert.match(out.reply ?? '', /FORM/); assert.match(out.reply ?? '', /Sam/); }
    if (scenario.business && !scenario.replied) assert.match(out.reply ?? '', /Example Kitchens/);
    if (!scenario.business) assert.doesNotMatch(out.reply ?? '', /Example Kitchens/);
    if (scenario.text.includes('123 Example Street')) assert.equal(out.brief.propertyAddress, '123 Example Street');
    if (scenario.replied) {
      assert.match(out.brief.reportedMeasurements ?? '', /13/);
      assert.match(out.brief.style ?? '', /green/i);
      assert.doesNotMatch(out.reply ?? '', /I(?:’|')m FORM|what(?:’s| is) (?:the|your) (?:property )?address/i);
    }
    console.log(JSON.stringify({ scenario: scenario.name, pass: true, reply: out.reply, brief: out.brief }));
  } catch (error) {
    failures++;
    console.log(JSON.stringify({ scenario: scenario.name, pass: false, error: error instanceof assert.AssertionError ? error.message : 'MODEL_REQUEST_FAILED',
      ...(error instanceof OpenAI.APIError ? { status: error.status, code: error.code } : {}) }));
  }
}
process.exitCode = failures ? 1 : 0;
