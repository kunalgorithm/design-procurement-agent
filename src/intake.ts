import type { AgentContext, Brief, Decision } from './domain.js';

export const intakeQuestion = 'Anything else you’d like to add before I create your first design?';

export function missingIntakeQuestion(brief: Brief): string | null {
  if (!brief.propertyAddress?.trim()) return 'What is the property address for this kitchen?';
  if (!brief.intake || brief.intake.currentKitchen === 'pending') return 'Do you have photos of your current kitchen? If you’ve already sent them, let me know which ones show your space.';
  if (brief.imageReferences?.some((file) => file.purpose === 'unknown')) return 'Do those kitchen images show your current space or are they inspiration for the new design?';
  if (brief.intake.floorPlan === 'pending') return 'Do you have a floor plan or a quick sketch handy? It’s okay if you don’t.';
  if (brief.intake.preferences === 'pending') return 'What would you love to change—more space or storage, new materials, or a particular color or feel?';
  return null;
}

function ask(decision: Decision, summary = 'I’ve saved your kitchen details.'): Decision {
  return { ...decision, handoff: null, intakeConfirmation: { action: 'ask', messageId: null },
    reply: summary.endsWith(intakeQuestion) ? summary : `${summary.trim().slice(0, 2900)} ${intakeQuestion}`.trim() };
}

export function validateInitialIntake(decision: Decision, context: AgentContext, designCount: number): Decision {
  if (designCount > 0 || decision.handoff && decision.handoff.kind !== 'design') return { ...decision, intakeConfirmation: null };
  const generating = decision.handoff?.kind === 'design';
  const action = decision.intakeConfirmation;
  if (!generating && action?.action !== 'ask') return { ...decision, intakeConfirmation: null };
  const missing = missingIntakeQuestion(decision.brief);
  if (missing) return { ...decision, handoff: null, intakeConfirmation: null, reply: missing };
  if (!generating) return ask(decision, decision.reply ?? undefined);

  const checkpoint = context.intakeCheckpoint;
  const latestUser = context.messages.findLast((message) => message.role === 'user');
  // The model interprets their reply; bind that interpretation to a delivered question
  // and the latest actual message. An upload, an older yes, or silence is not readiness.
  const confirmed = action?.action === 'confirm' && checkpoint?.role === 'assistant'
    && checkpoint.conversation_id === context.conversation.id
    && !missingIntakeQuestion(context.conversation.brief)
    && latestUser?.id === action.messageId && latestUser.conversation_id === context.conversation.id
    && latestUser.text.trim() && BigInt(latestUser.seq) > BigInt(checkpoint.seq)
    && ![...context.messages, ...context.referenceMessages ?? []].some((message) => message.role === 'user'
      && BigInt(message.seq) > BigInt(checkpoint.seq) && message.attachments.length);
  return confirmed ? decision : ask(decision);
}
