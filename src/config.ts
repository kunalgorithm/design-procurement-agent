import { z } from 'zod';
import { normalizePhoneNumber } from './chat-commands.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().min(32),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-5.6-terra'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2.5-sunburst'),
  MESSAGING_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  LINQ_API_KEY: z.string().default(''),
  LINQ_FROM_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/).or(z.literal('')).default(''),
  FORM_CONTACT_EMAIL: z.email().or(z.literal('')).default(''),
  FORM_CONTACT_WEBSITE: z.url({ protocol: /^https?$/ }).or(z.literal('')).default(''),
  LINQ_WEBHOOK_SECRET: z.string().default(''),
  LINQ_ALLOWED_HANDLES: z.string().default(''),
  LINQ_ADMIN_NUMBERS: z.string().default('').transform((value, ctx) => {
    const numbers = value.split(',').map((item) => item.trim()).filter(Boolean).map(normalizePhoneNumber);
    if (numbers.some((number) => !number)) {
      ctx.addIssue({ code: 'custom', message: 'Use comma-separated international phone numbers, each beginning with +' });
      return z.NEVER;
    }
    return [...new Set(numbers as string[])];
  }),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(3),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(250),
  REPLY_DEBOUNCE_MS: z.coerce.number().int().min(0).max(10000).default(500),
}).superRefine((value, ctx) => {
  if (value.MESSAGING_MODE === 'live') {
    for (const key of ['LINQ_API_KEY', 'LINQ_WEBHOOK_SECRET'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required in live mode' });
    }
  }
});

export type Config = z.infer<typeof schema>;
export const readConfig = (environment: NodeJS.ProcessEnv = process.env) => schema.parse(environment);
