import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().min(32),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  MESSAGING_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  LINQ_API_KEY: z.string().default(''),
  LINQ_WEBHOOK_SECRET: z.string().default(''),
  LINQ_ALLOWED_HANDLES: z.string().default(''),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  REPLY_DEBOUNCE_MS: z.coerce.number().int().min(0).max(10000).default(1500),
}).superRefine((value, ctx) => {
  if (value.MESSAGING_MODE === 'live') {
    for (const key of ['LINQ_API_KEY', 'LINQ_WEBHOOK_SECRET'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required in live mode' });
    }
  }
});

export type Config = z.infer<typeof schema>;
export const readConfig = (environment: NodeJS.ProcessEnv = process.env) => schema.parse(environment);
