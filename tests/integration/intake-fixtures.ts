import assert from 'node:assert/strict';
import { validateDecision, type AgentContext, type Decision, type IncomingMessage } from '../../src/domain.js';
import { Store } from '../../src/store.js';
import { decision, incoming, readyBrief } from '../fixtures.js';

// Put regression scenarios after a real completed checkpoint and its customer reply.
export async function prepareFirstDesign(store: Store, message: IncomingMessage, channel: 'linq' | 'sandbox') {
  const initial = await store.ingest(message, channel);
  const claim = await store.claim(); assert.ok(claim); assert.equal(claim.turn.id, initial.turnId);
  try {
    const ctx = (await store.context(initial.conversationId!))!;
    const out = validateDecision(decision({ brief: readyBrief(), reply: 'More storage, with room to cook.',
      intakeConfirmation: { action: 'ask', messageId: null } }), ctx);
    await store.saveDecision(claim.turn.id, out);
    await store.finish(claim.turn, out, channel === 'linq' ? `fixture-${claim.turn.id}` : null);
  } finally { await store.release(claim); }
  return store.ingest(incoming({ chatId: message.chatId, sender: message.sender, owner: message.owner,
    isGroup: message.isGroup, text: 'Nothing else, go ahead.' }), channel);
}

export function confirmedDesign(ctx: AgentContext, out: Decision): Decision {
  assert.ok(ctx.intakeCheckpoint, 'Design fixture requires a delivered checkpoint');
  return { ...out, brief: { ...out.brief, intake: readyBrief().intake },
    intakeConfirmation: { action: 'confirm', messageId: ctx.messages.findLast((message) => message.role === 'user')!.id } };
}
