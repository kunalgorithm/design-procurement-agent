import { toFile } from 'openai';
import type OpenAI from 'openai';
import type { AgentContext, Attachment, Decision } from './domain.js';
import { readProjectMedia, sandboxMediaId, saveGeneratedImage, sniffImage, type MediaRepository } from './media.js';

const referenceTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface DesignStudio {
  generate(context: AgentContext, decision: Decision): Promise<Attachment[]>;
}

export function shouldGenerateKitchen(decision: Decision) {
  return decision.handoff?.kind === 'design' && !!decision.brief.propertyAddress;
}

export function kitchenReferenceAttachments(context: AgentContext) {
  const messages = context.referenceMessages ?? context.messages;
  const latestDesign = messages.findLast((message) => message.role === 'assistant' && message.attachments.length);
  return [...messages.filter((message) => message.role !== 'assistant'), ...(latestDesign ? [latestDesign] : [])].flatMap((message) => message.attachments)
    .filter((attachment) => referenceTypes.includes(attachment.mimeType as typeof referenceTypes[number])
      && attachment.sizeBytes <= 20 * 1024 * 1024)
    .slice(-16);
}

export function buildKitchenPrompt(context: AgentContext, decision: Decision) {
  const brief = decision.brief;
  const notes = [
    brief.style && `Style: ${brief.style}`,
    brief.materials.length && `Materials: ${brief.materials.join(', ')}`,
    brief.appliances.length && `Appliances: ${brief.appliances.join(', ')}`,
    brief.goals.length && `Goals: ${brief.goals.join('; ')}`,
    brief.constraints.length && `Constraints: ${brief.constraints.join('; ')}`,
    brief.reportedMeasurements && `Reported measurements: ${brief.reportedMeasurements}`,
  ].filter(Boolean);
  const volunteered = context.messages
    .filter((message) => message.role === 'user' && message.text.trim())
    .slice(-8)
    .map((message) => message.text.trim());
  return [
    'Photoreal photograph of a completed kitchen renovation interior.',
    `Property: ${brief.propertyAddress}.`,
    'The attached images may include the existing kitchen, a floor plan or sketch, inspiration, and a previous proposal.',
    'Preserve implied architecture, window placement, and layout from the current kitchen and any floor plan.',
    'Apply inspiration for materials, color, lighting, and style. Show a finished, livable kitchen.',
    'No text overlays, watermarks, floor-plan drawings, collage frames, or UI chrome.',
    notes.length ? notes.join('\n') : '',
    volunteered.length ? `Notes from the conversation:\n${volunteered.join('\n')}` : '',
    decision.handoff?.summary ? `Revision brief: ${decision.handoff.summary}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function loadReferenceImage(attachment: Attachment, media?: MediaRepository) {
  if (attachment.sizeBytes > 20 * 1024 * 1024) return null;
  const id = sandboxMediaId(attachment.url);
  if (id) {
    const file = await readProjectMedia(id, media);
    if (!file || !referenceTypes.includes(file.mimeType as typeof referenceTypes[number])) return null;
    return { bytes: file.bytes, mimeType: file.mimeType, filename: file.filename };
  }
  const dataUrl = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(attachment.url);
  if (dataUrl) {
    return { bytes: Buffer.from(dataUrl[2]!, 'base64'), mimeType: dataUrl[1]!, filename: attachment.filename };
  }
  if (!URL.canParse(attachment.url)) return null;
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.linqapp.com' || url.username || url.password) return null;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = sniffImage(bytes);
  if (!mimeType || !referenceTypes.includes(mimeType as typeof referenceTypes[number])) return null;
  return { bytes, mimeType, filename: attachment.filename };
}

export class OpenAIDesignStudio implements DesignStudio {
  constructor(private readonly client: OpenAI, private readonly model: string, private readonly media?: MediaRepository) {}

  async generate(context: AgentContext, decision: Decision) {
    let prompt = buildKitchenPrompt(context, decision);
    const references = [];
    const descriptions: string[] = [];
    for (const attachment of kitchenReferenceAttachments(context)) {
      const file = await loadReferenceImage(attachment, this.media);
      if (file) {
        references.push(file);
        const isDesign = (context.referenceMessages ?? context.messages).some((m) => m.role === 'assistant' && m.attachments.some((a) => a.id === attachment.id));
        const purpose = isDesign ? 'latest FORM design: revision baseline' : decision.brief.imageReferences?.find((ref) => ref.attachmentId === attachment.id)?.purpose ?? 'user upload; role not confirmed';
        descriptions.push(`Image ${references.length}: ${purpose} (attachment ${attachment.id}).`);
      }
    }
    if (!references.length) throw Object.assign(new Error('REFERENCE_IMAGES_UNAVAILABLE'), { status: 422, code: 'REFERENCE_IMAGES_UNAVAILABLE' });
    prompt += `\n\nReference order:\n${descriptions.join('\n')}\nUse current-kitchen photos and floor plans for architecture. Use inspiration only for finishes and style. On revisions preserve the latest design except for requested changes. If no current-kitchen photo or plan is provided, this is a concept, not a verified recreation of the property.`;
    const options = { timeout: 180_000, maxRetries: 0 as const };
    const result = await this.client.images.edit({
      image: await Promise.all(references.map((file, index) => toFile(file.bytes, file.filename || `reference-${index}.jpg`, { type: file.mimeType }))),
      prompt, model: this.model, n: 1, size: '1536x1024', quality: 'medium',
      output_format: 'jpeg',
      ...(['gpt-image-1', 'gpt-image-1.5'].includes(this.model) || this.model.startsWith('gpt-image-1.5-')
        ? { input_fidelity: 'high' as const } : {}),
    }, options);
    const encoded = result.data?.[0]?.b64_json;
    if (!encoded) throw Object.assign(new Error('IMAGE_GENERATION_EMPTY'), { status: 502 });
    const bytes = Buffer.from(encoded, 'base64');
    const attachment = await saveGeneratedImage(bytes);
    await this.media?.saveMedia(context.conversation.id, attachment, bytes);
    return [attachment];
  }
}
