import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ResponseInput, ResponseInputContent } from 'openai/resources/responses/responses';
import { modelDecisionSchema, participantContext, senderRole, type Agent, type AgentContext, type Attachment } from './domain.js';
import { readProjectMedia, sandboxMediaId, type MediaRepository } from './media.js';

const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function modelAttachment(attachment: Attachment): ResponseInputContent | null {
  if (attachment.sizeBytes > 20 * 1024 * 1024) return null;
  if (imageTypes.includes(attachment.mimeType) && (
    attachment.url.startsWith(`data:${attachment.mimeType};base64,`) || sandboxMediaId(attachment.url)
  )) {
    return { type: 'input_image', image_url: attachment.url, detail: 'auto' };
  }
  if (!URL.canParse(attachment.url)) return null;
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.linqapp.com' || url.username || url.password) return null;
  if (imageTypes.includes(attachment.mimeType)) {
    return { type: 'input_image', image_url: attachment.url, detail: 'auto' };
  }
  if (attachment.mimeType === 'application/pdf') return { type: 'input_file', file_url: attachment.url };
  return null;
}

export async function resolveModelAttachment(attachment: Attachment, media?: MediaRepository): Promise<ResponseInputContent | null> {
  const part = modelAttachment(attachment);
  if (!part || part.type !== 'input_image') return part;
  const id = sandboxMediaId(attachment.url);
  if (!id) return part;
  const file = await readProjectMedia(id, media);
  const dataUrl = file ? `data:${file.mimeType};base64,${file.bytes.toString('base64')}` : null;
  return dataUrl ? { type: 'input_image', image_url: dataUrl, detail: 'auto' } : null;
}

export class OpenAIAgent implements Agent {
  constructor(private readonly client: OpenAI, private readonly model: string, private readonly media?: MediaRepository) {}
  async respond(context: AgentContext) {
    // Read each turn so prompt edits also work with the development watcher.
    const prompt = await readFile(new URL('../prompts/designer.md', import.meta.url), 'utf8');
    const input: ResponseInput = [{ role: 'developer', content: prompt }, {
      role: 'developer', content: participantContext(context),
    }];
    const references = context.referenceMessages ?? context.messages;
    const newestUploads = references.filter((m) => m.role !== 'assistant').flatMap((message) =>
      message.attachments.map((attachment) => ({ message, attachment }))).reverse();
    const latestDesign = references.findLast((m) => m.role === 'assistant' && m.attachments.length)?.attachments[0];
    const selected = new Map<string, ResponseInputContent>();
    // Reserve one slot for the current design, then prefer newest user references.
    if (latestDesign) {
      const part = await resolveModelAttachment(latestDesign, this.media);
      if (part) selected.set(latestDesign.id, part);
    }
    for (const { message, attachment } of newestUploads) {
      if (selected.size >= 5) break;
      if (selected.has(attachment.id)) continue;
      const isLocal = !!sandboxMediaId(attachment.url) || attachment.url.startsWith('data:');
      if (!isLocal && Date.now() - new Date(message.created_at).getTime() >= 10 * 60 * 1000) continue;
      const part = await resolveModelAttachment(attachment, this.media);
      if (part) selected.set(attachment.id, part);
    }
    const mediaCount = selected.size;
    const appendMedia = (attachments: Attachment[], label: string): ResponseInputContent[] => attachments.flatMap((attachment) => {
      const part = selected.get(attachment.id);
      if (!part) return [];
      selected.delete(attachment.id);
      const purpose = context.conversation.brief.imageReferences?.find((ref) => ref.attachmentId === attachment.id)?.purpose ?? 'unknown';
      return [{ type: 'input_text' as const, text: `${label}; attachment ID: ${attachment.id}; image role: ${purpose}.` }, part];
    });
    // Keep relevant images available even after their original message leaves the text window.
    for (const message of references.filter((ref) => !context.messages.some((message) => message.id === ref.id))) {
      const media = appendMedia(message.attachments, message.role === 'assistant' ? 'Latest FORM design' : `Earlier user upload: ${message.text}`);
      if (media.length) input.push({ role: 'user', content: media });
    }
    for (const message of context.messages) {
      if (message.role === 'assistant') {
        input.push({ role: 'assistant', content: message.text });
        const media = appendMedia(message.attachments, 'Previous FORM design, shown here only as a visual reference');
        if (media.length) input.push({ role: 'user', content: media });
        continue;
      }
      const content: ResponseInputContent[] = [{
        type: 'input_text',
        text: JSON.stringify({ sender: message.sender, role: senderRole(message.sender), source: message.role, text: message.text, attachments: message.attachments }),
      }, ...appendMedia(message.attachments, 'User-provided image or document')];
      input.push({ role: 'user', content });
    }
    const generate = (messages: ResponseInput) => this.client.responses.parse({
      model: this.model, input: messages, store: false, max_output_tokens: 5000,
      text: { format: zodTextFormat(modelDecisionSchema, 'kitchen_conversation_turn') },
    });
    let response;
    try { response = await generate(input); }
    catch (error) {
      if (!(error instanceof OpenAI.APIError) || error.status !== 400 || mediaCount === 0) throw error;
      // A recently received CDN URL can still expire before the provider reads it.
      // Retry once with text only so the agent can ask for a fresh upload.
      const textOnly = input.map((item) => ('content' in item && Array.isArray(item.content)
        ? { ...item, content: item.content.filter((part) => part.type !== 'input_image' && part.type !== 'input_file') }
        : item)) as ResponseInput;
      textOnly.push({ role: 'developer', content: 'Media could not be read on this turn. No attachment contents are available. Ask for a fresh JPEG/PNG, readable PDF, or text description if needed; never infer contents from metadata.' });
      response = await generate(textOnly);
    }
    if (!response.output_parsed) throw new Error('MODEL_NO_STRUCTURED_OUTPUT');
    return modelDecisionSchema.parse(response.output_parsed);
  }
}
