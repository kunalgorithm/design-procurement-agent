import Linq from '@linqapp/sdk';
import { z } from 'zod';
import type { Attachment, IncomingMessage, Messenger, Reaction, ChatParticipants } from './domain.js';
import { normalizePhoneNumber } from './chat-commands.js';

import { readProjectMedia, type MediaRepository } from './media.js';

const handle = z.object({ handle: z.string().min(1).max(200), is_me: z.boolean().nullish() });
const eventSchema = z.object({
  event_id: z.string().min(1).max(200), event_type: z.string(),
  created_at: z.string().datetime({ offset: true }).nullish(),
  webhook_version: z.literal('2026-02-03'),
  data: z.object({
    id: z.string().min(1).max(200), direction: z.enum(['inbound', 'outbound']),
    chat: z.object({ id: z.string().uuid(), is_group: z.boolean().nullish(), owner_handle: handle.nullish() }),
    sender_handle: handle, service: z.string(), sent_at: z.string().datetime({ offset: true }).nullish(),
    reconciled_at: z.string().nullish(),
    parts: z.array(z.object({
      type: z.string(), value: z.string().nullish(), url: z.string().nullish(),
      id: z.string().nullish(), mime_type: z.string().nullish(),
      filename: z.string().nullish(), size_bytes: z.number().nonnegative().nullish(),
    })).max(100),
  }),
});

export function normalizeEvent(payload: unknown): IncomingMessage | null {
  const envelope = z.object({ event_type: z.string() }).parse(payload);
  if (envelope.event_type !== 'message.received') return null;
  const event = eventSchema.parse(payload);
  const data = event.data;
  if (data.direction !== 'inbound' || data.sender_handle.is_me || data.reconciled_at) return null;
  const text = data.parts.filter((p) => p.type === 'text' || p.type === 'link').map((p) => p.value ?? '').join('\n').slice(0,16000);
  const attachments = data.parts.filter((p) => p.type === 'media' && p.id && p.url).map((p) => ({
    id: p.id!, url: p.url!, mimeType: p.mime_type ?? 'application/octet-stream',
    filename: p.filename ?? 'attachment', sizeBytes: p.size_bytes ?? 0,
  }));
  if (!text.trim() && !attachments.length) return null;
  return {
    eventId: event.event_id, messageId: data.id, chatId: data.chat.id,
    sender: data.sender_handle.handle, owner: data.chat.owner_handle?.handle ?? null,
    isGroup: data.chat.is_group ?? false, service: data.service,
    text, attachments, sentAt: data.sent_at ?? event.created_at ?? new Date().toISOString(),
  };
}

export function createLinq(apiKey: string, webhookSecret: string) {
  return new Linq({ apiKey, webhookSecret, timeout: 20000, maxRetries: 0 });
}

export class LinqMessenger implements Messenger {
  constructor(private readonly client: Linq, private readonly media?: MediaRepository, private readonly upload: typeof fetch = fetch) {}
  async chatParticipants(chatId: string, owner?: string | null): Promise<ChatParticipants> {
    const chat = await this.client.chats.retrieve(chatId);
    if (chat.id !== chatId) throw new Error('CHAT_ID_MISMATCH');
    const active = chat.handles.filter((person) => !person.left_at && person.status !== 'left' && person.status !== 'removed');
    const owned = active.filter((person) => person.is_me);
    const line = owner
      ? owned.find((person) => normalizePhoneNumber(person.handle) === normalizePhoneNumber(owner))
      : owned.length === 1 ? owned[0] : undefined;
    if (!line || !normalizePhoneNumber(line.handle)) throw new Error('CHAT_OWNER_MISMATCH');
    return {
      handles: [...new Set(active.filter((person) => !person.is_me).map((person) => normalizePhoneNumber(person.handle) ?? person.handle))],
      owner: normalizePhoneNumber(line.handle)!, isGroup: chat.is_group,
    };
  }
  async react(messageId: string, emoji: Reaction): Promise<void> {
    await this.client.messages.addReaction(messageId, emoji === '❤️'
      ? { operation: 'add', type: 'love' }
      : emoji === '👍' ? { operation: 'add', type: 'like' }
        : { operation: 'add', type: 'custom', custom_emoji: emoji });
  }
  async send(chatId: string, text: string, idempotencyKey: string, attachments: Attachment[] = []): Promise<string> {
    const parts: Array<{ type: 'text'; value: string } | { type: 'media'; attachment_id: string }> = [];
    if (text) parts.push({ type: 'text', value: text });
    for (const attachment of attachments) {
      let providerId = await this.media?.providerAttachment(attachment.id);
      if (!providerId) {
        const file = await readProjectMedia(attachment.id, this.media);
        if (!file || file.mimeType !== 'image/jpeg') throw Object.assign(new Error('RENDER_UNAVAILABLE'), { status: 422 });
        const upload = await this.client.attachments.create({ filename: file.filename, content_type: 'image/jpeg', size_bytes: file.bytes.length });
        const response = await this.upload(upload.upload_url, {
          method: 'PUT', headers: upload.required_headers, body: new Uint8Array(file.bytes), signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw Object.assign(new Error('MEDIA_UPLOAD_FAILED'), { status: response.status });
        providerId = upload.attachment_id;
        await this.media?.saveProviderAttachment(attachment.id, providerId);
      }
      parts.push({ type: 'media', attachment_id: providerId });
    }
    const response = await this.client.chats.messages.send(chatId, {
      message: { parts, idempotency_key: idempotencyKey },
    });
    return response.message.id;
  }
}
