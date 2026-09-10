import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import type { Config } from './config.js';
import { createLinq, normalizeEvent } from './linq.js';
import type { Store } from './store.js';

export function createApp(config: Config, store: Store) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
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
  api.use(express.json({ limit: '64kb' }));
  api.get('/conversations', async (_req, res) => res.json({ conversations: await store.listConversations() }));
  api.get('/conversations/:id', async (req, res) => {
    const context = await store.context(z.string().uuid().parse(req.params.id));
    if (!context) { res.status(404).json({ error: 'Conversation not found' }); return; }
    res.json(context);
  });
  api.patch('/conversations/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(req.body);
    const conversation = await store.pause(id, paused);
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
  api.post('/sandbox/messages', async (req, res) => {
    const input = z.object({
      sessionId: z.string().uuid().optional(), message: z.string().trim().min(1).max(16000),
      sender: z.string().min(1).max(200).default('homeowner'), isGroup: z.boolean().default(true),
      requestId: z.string().uuid().optional(),
    }).strict().parse(req.body);
    const messageId = input.requestId ?? randomUUID();
    const sessionId = input.sessionId ?? messageId;
    const result = await store.ingest({ eventId: messageId, messageId, chatId: sessionId, sender: input.sender,
      owner: null, isGroup: input.isGroup, service: 'sandbox', text: input.message, attachments: [], sentAt: new Date().toISOString() }, 'sandbox');
    res.status(202).json({ sessionId, ...result });
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
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', fields: error.issues.map((issue) => issue.path.join('.')) }); return;
    }
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
