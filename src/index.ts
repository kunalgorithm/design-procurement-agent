import OpenAI from 'openai';
import { pino } from 'pino';
import { readConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { Store } from './store.js';
import { OpenAIAgent } from './agent.js';
import { OpenAIDesignStudio } from './design.js';
import { createLinq, LinqMessenger } from './linq.js';
import { Worker } from './worker.js';
import { createApp } from './app.js';

const config = readConfig();
const logger = pino({ level: config.LOG_LEVEL });
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => logger.error('Idle database connection failed'));
await migrate(pool);
const store = new Store(pool, config.REPLY_DEBOUNCE_MS);
const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY, timeout: 60000, maxRetries: 0 });
const agent = new OpenAIAgent(openai, config.OPENAI_MODEL, store);
const design = new OpenAIDesignStudio(openai, config.OPENAI_IMAGE_MODEL, store);
const messenger = new LinqMessenger(createLinq(config.LINQ_API_KEY || 'sandbox-disabled', config.LINQ_WEBHOOK_SECRET), store);
const worker = new Worker(store, agent, messenger, logger, config.WORKER_POLL_MS, config.MESSAGING_MODE, design, config.WORKER_CONCURRENCY);
const server = createApp(config, store).listen(config.PORT, '0.0.0.0', () => {
  logger.info({ port: config.PORT, mode: config.MESSAGING_MODE, model: config.OPENAI_MODEL, imageModel: config.OPENAI_IMAGE_MODEL }, 'Server listening');
  worker.start();
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down');
  const deadline = setTimeout(() => process.exit(1), 90000).unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await worker.stop();
  await closed;
  await pool.end();
  clearTimeout(deadline);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
