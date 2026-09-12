import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Attachment } from './domain.js';

export class BadMediaError extends Error {}

const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
const uploadSchema = z.object({
  filename: z.string().min(1).max(500),
  mimeType: z.enum(imageTypes),
  data: z.string().min(1).max(28_000_000),
}).strict();

const mediaDir = () => process.env.SANDBOX_MEDIA_DIR
  || (process.env.NODE_ENV === 'production' ? '/tmp/design-procurement-agent-media' : fileURLToPath(new URL('../data/sandbox-media', import.meta.url)));

export function sandboxMediaPath(id: string) {
  return `/api/media/${id}`;
}

export function sandboxMediaId(url: string) {
  const match = /^\/(?:api|local)\/media\/([^/?#]+)$/.exec(url);
  if (!match?.[1]) return null;
  const parsed = z.string().uuid().safeParse(match[1]);
  return parsed.success ? parsed.data : null;
}

export function sniffImage(bytes: Buffer) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function ensureDir() {
  await mkdir(mediaDir(), { recursive: true });
}

export async function writeSandboxMedia(id: string, bytes: Buffer, meta: { mimeType: string; filename: string }) {
  await ensureDir();
  await writeFile(`${mediaDir()}/${id}`, bytes);
  await writeFile(`${mediaDir()}/${id}.json`, JSON.stringify(meta));
}

export async function readSandboxMedia(id: string) {
  try {
    const [bytes, raw] = await Promise.all([readFile(`${mediaDir()}/${id}`), readFile(`${mediaDir()}/${id}.json`, 'utf8')]);
    const meta = z.object({ mimeType: z.string(), filename: z.string() }).parse(JSON.parse(raw));
    return { bytes, ...meta };
  } catch {
    return null;
  }
}

export async function readSandboxMediaDataUrl(id: string) {
  const file = await readSandboxMedia(id);
  if (!file) return null;
  return `data:${file.mimeType};base64,${file.bytes.toString('base64')}`;
}

export async function saveGeneratedImage(bytes: Buffer, filename = 'kitchen-redesign.jpg'): Promise<Attachment> {
  if (!bytes.length) throw new BadMediaError('Generated image was empty');
  const mimeType = sniffImage(bytes) ?? 'image/jpeg';
  const id = randomUUID();
  await writeSandboxMedia(id, bytes, { mimeType, filename });
  return { id, url: sandboxMediaPath(id), mimeType, filename, sizeBytes: bytes.length };
}

export async function saveSandboxUploads(uploads: unknown): Promise<Attachment[]> {
  const items = z.array(uploadSchema).max(5).parse(uploads ?? []);
  const attachments: Attachment[] = [];
  for (const item of items) {
    const bytes = Buffer.from(item.data, 'base64');
    if (!bytes.length) throw new BadMediaError('Photo data was empty');
    if (bytes.length > 20 * 1024 * 1024) throw new BadMediaError('Each photo must be 20 MB or smaller');
    const mimeType = sniffImage(bytes);
    if (!mimeType) throw new BadMediaError('Use a JPEG, PNG, WebP, or GIF');
    const id = randomUUID();
    const filename = basename(item.filename).slice(0, 500) || 'photo.jpg';
    await writeSandboxMedia(id, bytes, { mimeType, filename });
    attachments.push({ id, url: sandboxMediaPath(id), mimeType, filename, sizeBytes: bytes.length });
  }
  return attachments;
}
