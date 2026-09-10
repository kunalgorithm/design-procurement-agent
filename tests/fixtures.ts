import { createHmac, randomUUID } from 'node:crypto';
import { emptyBrief, type AgentContext, type Decision, type IncomingMessage } from '../src/domain.js';

export const webhookSecret = `whsec_${Buffer.from('test-signing-secret-not-a-real-key').toString('base64')}`;
export function event() {
  return {
    event_id: randomUUID(), event_type: 'message.received', webhook_version: '2026-02-03',
    data: {
      id: randomUUID(), direction: 'inbound',
      chat: { id: randomUUID().toString(), is_group: true, owner_handle: { handle: '+12025550100', is_me: true } },
      sender_handle: { handle: '+12025550101', is_me: false }, service: 'iMessage', sent_at: new Date().toISOString(),
      parts: [{ type: 'text', value: 'I am the contractor. We want to renovate this kitchen.' }] as Array<Record<string, unknown>>,
    },
  };
}
export function sign(body: string, seconds = Math.floor(Date.now() / 1000)) {
  const id = randomUUID();
  const signature = createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64')).update(`${id}.${seconds}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(seconds), 'webhook-signature': `v1,${signature}` };
}
export function incoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { eventId: randomUUID(), messageId: randomUUID(), chatId: randomUUID(), sender: '+12025550101',
    owner: '+12025550100', isGroup: true, service: 'iMessage', text: 'We want more storage.', attachments: [],
    sentAt: new Date().toISOString(), ...overrides };
}
export function decision(overrides: Partial<Decision> = {}): Decision {
  return { reply: 'Please share a few pictures of the existing kitchen.', brief: emptyBrief(), handoff: null, ...overrides };
}
export function context(): AgentContext {
  return { conversation: { id: randomUUID(), external_id: randomUUID(), channel: 'linq', is_group: true,
    owner_handle: '+12025550100', paused: false, brief: emptyBrief(), created_at: new Date(), updated_at: new Date() }, messages: [], handoffs: [] };
}
