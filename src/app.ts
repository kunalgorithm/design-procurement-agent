import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { contractorRouter } from './contractors.js';
import type { Config } from './config.js';
import { createLinq, normalizeEvent } from './linq.js';
import { BadMediaError, readSandboxMedia, saveSandboxUploads } from './media.js';
import type { Store } from './store.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const sandboxMessageSchema = z.object({
  sessionId: z.string().uuid().optional(), message: z.string().max(16000).default(''),
  sender: z.string().min(1).max(200).default('homeowner'), isGroup: z.boolean().default(true),
  requestId: z.string().uuid().optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1).max(500),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    data: z.string().min(1).max(28_000_000),
  }).strict()).max(5).default([]),
}).strict().superRefine((value, ctx) => {
  if (!value.message.trim() && value.attachments.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['message'], message: 'Message or photo required' });
  }
});

async function queueSandboxMessage(store: Store, req: Request, res: Response) {
  const input = sandboxMessageSchema.parse(req.body);
  const attachments = await saveSandboxUploads(input.attachments);
  const messageId = input.requestId ?? randomUUID();
  const sessionId = input.sessionId ?? messageId;
  const result = await store.ingest({ eventId: messageId, messageId, chatId: sessionId, sender: input.sender,
    owner: null, isGroup: input.isGroup, service: 'sandbox', text: input.message.trim(), attachments, sentAt: new Date().toISOString() }, 'sandbox');
  res.status(202).json({ sessionId, ...result });
}

export function createApp(config: Config, store: Store) {
  const app = express();
  app.disable('x-powered-by');
  // The deployed service receives traffic through Render’s reverse proxy.
  if (config.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:', 'https://images.ctfassets.net'],
        ...(config.NODE_ENV === 'development' ? { 'upgrade-insecure-requests': null } : {}),
      },
    },
  }));
  app.use((_req, res, next) => { res.set('X-Request-ID', randomUUID()); next(); });

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'design-procurement-agent' }));
  app.get('/readyz', async (_req, res) => {
    try { await store.pool.query('SELECT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });

  const linq = createLinq(config.LINQ_API_KEY || 'sandbox-disabled', config.LINQ_WEBHOOK_SECRET);
  const allowedHandles = new Set(config.LINQ_ALLOWED_HANDLES.split(',').map((value) => value.trim()).filter(Boolean));
  app.post('/webhooks/linq', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    if (config.MESSAGING_MODE !== 'live') { res.status(503).json({ error: 'Live webhooks are disabled in sandbox mode' }); return; }
    if (!Buffer.isBuffer(req.body)) { res.status(415).json({ error: 'Expected application/json' }); return; }
    let payload: unknown;
    try {
      const headers: Record<string, string> = {};
      for (const key of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) headers[key] = req.get(key) ?? '';
      payload = linq.webhooks.unwrap(req.body.toString('utf8'), { headers });
    } catch { res.status(401).json({ error: 'Invalid webhook signature or payload' }); return; }
    const message = normalizeEvent(payload);
    if (!message) { res.status(200).json({ ignored: true }); return; }
    if (allowedHandles.size && (!message.owner || !allowedHandles.has(message.owner))) {
      res.status(200).json({ ignored: true }); return;
    }
    // Commit first; the worker handles all model calls and outbound delivery later.
    res.status(200).json(await store.ingest(message, 'linq'));
  });

  app.get('/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (config.NODE_ENV === 'development') {
      res.json({ authRequired: false, token: config.ADMIN_API_KEY });
      return;
    }
    res.json({ authRequired: true });
  });

  app.use('/api/contractors', express.json({ limit: '16kb' }), contractorRouter(config, store));

  const api = express.Router();
  api.use((req, res, next) => {
    const supplied = req.get('authorization') ?? '';
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(supplied), hash(`Bearer ${config.ADMIN_API_KEY}`))) {
      res.status(401).json({ error: 'Unauthorized' }); return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.post('/sandbox/messages', express.json({ limit: '25mb' }), (req, res, next) => {
    void queueSandboxMessage(store, req, res).catch(next);
  });
  api.use(express.json({ limit: '64kb' }));
  api.get('/media/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const file = await readSandboxMedia(id);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }
    res.set('Content-Type', file.mimeType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(file.bytes);
  });
  api.get('/conversations', async (_req, res) => res.json({ conversations: await store.listConversations() }));
  api.get('/conversations/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const context = await store.context(id);
    if (!context) { res.status(404).json({ error: 'Conversation not found' }); return; }
    res.json({ ...context, failedTurns: await store.listConversationTurns(id, 'failed') });
  });
  api.patch('/conversations/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(req.body);
    const conversation = await store.pause(id, paused);
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
    res.json({ conversation });
  });
  api.delete('/conversations/:id', async (req, res) => {
    const conversation = await store.clearConversation(z.string().uuid().parse(req.params.id), 'sandbox');
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
    res.json({ conversation });
  });
  api.post('/conversations/:id/messages', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { text, requestId } = z.object({ text: z.string().trim().min(1).max(3000), requestId: z.string().uuid() }).strict().parse(req.body);
    const turn = await store.queueOperator(id, text, requestId);
    if (!turn) { res.status(404).json({ error: 'Conversation not found' }); return; }
    res.status(202).json({ turnId: turn.id });
  });
  api.get('/turns', async (req, res) => {
    const status = z.enum(['pending','processing','done','failed','cancelled']).optional().parse(req.query.status);
    res.json({ turns: await store.listTurns(status) });
  });
  api.get('/turns/:id', async (req, res) => {
    const turn = await store.getTurn(z.string().uuid().parse(req.params.id));
    if (!turn) { res.status(404).json({ error: 'Turn not found' }); return; }
    res.json({ turn });
  });
  api.post('/turns/:id/retry', async (req, res) => {
    const turn = await store.retryTurn(z.string().uuid().parse(req.params.id));
    if (!turn) { res.status(409).json({ error: 'Only failed turns can be retried' }); return; }
    res.status(202).json({ turnId: turn.id });
  });
  api.get('/handoffs', async (_req, res) => res.json({ handoffs: await store.listHandoffs() }));
  api.patch('/handoffs/:id', async (req, res) => {
    z.object({ status: z.literal('completed') }).strict().parse(req.body);
    const task = await store.completeHandoff(z.string().uuid().parse(req.params.id));
    if (!task) { res.status(404).json({ error: 'Handoff not found' }); return; }
    res.json({ handoff: task });
  });
  app.use('/api', api);
  app.get(['/', '/contractors', '/signup'], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(`${publicDir}/site/index.html`);
  });
  app.get('/sandbox', (_req, res) => res.sendFile(`${publicDir}/index.html`));
  app.use(express.static(publicDir, { index: false }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', fields: error.issues.map((issue) => issue.path.join('.')) }); return;
    }
    if (error instanceof BadMediaError) { res.status(400).json({ error: error.message }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'Invalid JSON' }); return; }
    if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') {
      res.status(409).json({ error: 'Request ID already used for different content' }); return;
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Payload too large' }); return;
    }
    res.status(503).json({ error: 'Temporarily unavailable', requestId: res.get('X-Request-ID') });
  };
  app.use(errors);
  return app;
}
