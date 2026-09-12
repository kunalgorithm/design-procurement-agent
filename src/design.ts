import { toFile } from 'openai';
import type OpenAI from 'openai';
import type { AgentContext, Attachment, Decision } from './domain.js';
import { readSandboxMedia, sandboxMediaId, saveGeneratedImage, sniffImage } from './media.js';

const referenceTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface DesignStudio {
  generate(context: AgentContext, decision: Decision): Promise<Attachment[]>;
}

export function shouldGenerateKitchen(decision: Decision) {
  return decision.handoff?.kind === 'design' && !!decision.brief.propertyAddress;
}

export function kitchenReferenceAttachments(context: AgentContext) {
  return context.messages.flatMap((message) => message.attachments)
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

export async function loadReferenceImage(attachment: Attachment) {
  if (attachment.sizeBytes > 20 * 1024 * 1024) return null;
  const id = sandboxMediaId(attachment.url);
  if (id) {
    const file = await readSandboxMedia(id);
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
  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType = sniffImage(bytes);
  if (!mimeType || !referenceTypes.includes(mimeType as typeof referenceTypes[number])) return null;
  return { bytes, mimeType, filename: attachment.filename };
}

export class OpenAIDesignStudio implements DesignStudio {
  constructor(private readonly client: OpenAI, private readonly model: string) {}

  async generate(context: AgentContext, decision: Decision) {
    const prompt = buildKitchenPrompt(context, decision);
    const references = [];
    for (const attachment of kitchenReferenceAttachments(context)) {
      const file = await loadReferenceImage(attachment);
      if (file) references.push(file);
    }
    const options = { timeout: 90_000, maxRetries: 0 as const };
    const result = references.length
      ? await this.client.images.edit({
          image: await Promise.all(references.map((file, index) => toFile(file.bytes, file.filename || `reference-${index}.jpg`, { type: file.mimeType }))),
          prompt, model: this.model, n: 1, size: '1536x1024', quality: 'medium',
          output_format: 'jpeg', input_fidelity: 'high',
        }, options)
      : await this.client.images.generate({
          prompt, model: this.model, n: 1, size: '1536x1024', quality: 'medium', output_format: 'jpeg',
        }, options);
    const encoded = result.data?.[0]?.b64_json;
    if (!encoded) throw Object.assign(new Error('IMAGE_GENERATION_EMPTY'), { status: 502 });
    return [await saveGeneratedImage(Buffer.from(encoded, 'base64'))];
  }
}
