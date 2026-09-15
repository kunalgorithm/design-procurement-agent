// Opt-in synthetic dialogue checks. No app writes, images, or Linq messages.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { OpenAIAgent } from '../src/agent.js';
import { emptyBrief, validateDecision, type AgentContext } from '../src/domain.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
const agent = new OpenAIAgent(new OpenAI({ maxRetries: 0, timeout: 60000 }), process.env.OPENAI_MODEL || 'gpt-5.6-terra');
const profile = { id: randomUUID(), phone: '+12025550101', firstName: 'Sam', lastName: 'Rivera', businessName: 'Example Kitchens', website: null };
const cases: Array<{ name: string; registered: boolean; practice: string | null; previous: boolean; project: boolean; text: string; role?: 'homeowner' | 'contractor' }> = [
  { name: 'registered_greeting', registered: true, practice: profile.businessName, previous: false, project: false, text: 'Hi' },
  { name: 'registered_without_practice', registered: true, practice: null, previous: false, project: false, text: 'Hi' },
  { name: 'correct_previous_homeowner_assumption', registered: true, practice: null, previous: true, project: false, text: 'Do you recognize me from my signup?' },
  { name: 'contractor_introduces_client_project', registered: true, practice: profile.businessName, previous: false, project: true, text: 'I’m working on Sarah’s kitchen at 123 Example Street. She wants warm oak cabinets. Can you help?' },
  { name: 'unregistered_customer', registered: false, practice: null, previous: false, project: false, text: 'Hi' },
  { name: 'admin_client_with_contractor_signup', registered: true, practice: profile.businessName, previous: false, project: false, text: 'Hi', role: 'homeowner' },
  { name: 'admin_contractor_without_signup', registered: false, practice: null, previous: false, project: false, text: 'Hi', role: 'contractor' },
  { name: 'return_to_contractor', registered: true, practice: profile.businessName, previous: false, project: false, text: 'Hi', role: 'contractor' },
];
let failures = 0;
for (const scenario of cases) {
  const id = randomUUID();
  const ctx: AgentContext = { conversation: { id, external_id: randomUUID(), channel: 'linq', is_group: false,
    owner_handle: '+12025550100', participant_handles: [profile.phone], paused: false, brief: emptyBrief(), created_at: new Date(), updated_at: new Date() },
    handoffs: [], hasAssistantReply: scenario.previous, registeredContractors: scenario.registered ? [{ ...profile, businessName: scenario.practice }] : [],
    messages: [
      ...(scenario.previous ? [{ id: randomUUID(), seq: '1', conversation_id: id, role: 'assistant' as const, sender: 'FORM', text: 'Hi, I’m FORM. Could you send a few photos of your current kitchen?', attachments: [], created_at: new Date() }] : []),
      { id: randomUUID(), seq: '2', conversation_id: id, role: 'user', sender: profile.phone, text: scenario.text, attachments: [], created_at: new Date() },
    ],
  };
  if (scenario.role) { ctx.conversation.role_override = scenario.role; ctx.conversation.role_override_sender = profile.phone; }
  try {
    const out = validateDecision(await agent.respond(ctx), ctx);
    assert.equal(out.handoff, null);
    const contractor = scenario.role === 'contractor' || (scenario.registered && scenario.role !== 'homeowner');
    if (scenario.registered && contractor) {
      assert.equal(out.brief.contractorName, 'Sam Rivera'); assert.match(out.reply ?? '', /Sam/);
      if (!scenario.project) {
        assert.match(out.reply ?? '', /contractor|client|signup|sign.?up|registered/i);
        assert.doesNotMatch(out.reply ?? '', /photos of your (?:current |existing |own )?kitchen/i);
      }
      assert.doesNotMatch(out.reply ?? '', /what(?:’s| is) your name|are you (?:a |the )?contractor/i);
    } else {
      assert.equal(out.brief.contractorName, null); assert.doesNotMatch(out.reply ?? '', /Sam|Example Kitchens/);
    }
    if (contractor) {
      assert.doesNotMatch(out.reply ?? '', /(?:I['’]m|I am|this is) FORM|AI (?:design )?(?:assistant|agent)|thanks? (?:you )?for signing|welcome to FORM/i);
      if (!scenario.previous) assert.doesNotMatch(out.reply ?? '', /signup|sign.?up|registered|Example Kitchens/i);
      assert.doesNotMatch(out.reply ?? '', /photos of your (?:current |existing |own )?kitchen/i);
    } else {
      assert.match(out.reply ?? '', /FORM/);
      assert.doesNotMatch(out.reply ?? '', /contractor signup|your client|Sam|Example Kitchens|role (?:switch|test)|admin/i);
    }
    if (scenario.project) { assert.equal(out.brief.homeownerName, 'Sarah'); assert.equal(out.brief.propertyAddress, '123 Example Street'); }
    console.log(JSON.stringify({ scenario: scenario.name, pass: true, reply: out.reply }));
  } catch (error) {
    failures++; console.log(JSON.stringify({ scenario: scenario.name, pass: false, error: error instanceof assert.AssertionError ? error.message : 'MODEL_REQUEST_FAILED' }));
  }
}
console.log(JSON.stringify({ scenarios: cases.length, failures }));
process.exitCode = failures ? 1 : 0;
