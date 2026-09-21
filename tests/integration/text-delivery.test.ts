import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pino } from 'pino';
import { migrate } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { Worker } from '../../src/worker.js';
import type { Agent, Attachment, Messenger } from '../../src/domain.js';
import { decision, incoming, readyBrief } from '../fixtures.js';
import { intakeQuestion } from '../../src/intake.js';
import { prepareFirstDesign, confirmedDesign } from './intake-fixtures.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated test database');
const schema = `texts_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const store = new Store(pool, 0);
const logger = pino({ level: 'silent' });
const pieces = [
  'I can see the sink under the window and the range on the adjoining wall, with two cabinet runs meeting at one corner.',
  'We can keep that L-shaped layout and brighten the room with warm oak cabinets, light counters, and a simple backsplash.',
  'Do you have a floor plan or a quick sketch handy?',
];
const text = pieces.join('\n\n');
const model: Agent = { async respond() { return decision({ reply: text }); } };
const sent: { text: string; key: string; files: Attachment[] }[] = [];
const signals: boolean[] = [];
const messenger: Messenger = {
  async send(_chat, text, key, files = []) { sent.push({ text, key, files }); return `sent-${key}`; },
  async typing(_chat, active) { signals.push(active); },
};
const runner = (agent = model, transport = messenger, db = store) =>
  new Worker(db, agent, transport, logger, 100, 'live');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function deadline(promise: Promise<unknown>) {
  let timer!: NodeJS.Timeout;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Ready replies were blocked')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

before(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool); });
beforeEach(async () => { await pool.query('TRUNCATE conversations,webhook_events CASCADE'); sent.length = 0; signals.length = 0; });
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

test('long live replies arrive in order and stop typing once the answer is ready', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  const thinking = deferred();
  await runner({ async respond() { await thinking.promise; return decision({ reply: text }); } }, {
    ...messenger, async typing(chat, active) { await messenger.typing!(chat, active); if (active) thinking.resolve(); },
  }).tick();
  assert.deepEqual(sent.map((item) => item.text), pieces);
  assert.equal(sent[0]!.key, queued.turnId);
  assert.equal(new Set(sent.map((item) => item.key)).size, 3);
  assert.deepEqual(signals, [true, false]);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
  const replies = (await store.context(queued.conversationId!))!.messages.filter((message) => message.role === 'assistant');
  assert.equal(replies.length, 1); assert.equal(replies[0]!.text, text);
  assert.equal((await pool.query('SELECT * FROM reply_parts WHERE turn_id=$1 AND sent_at IS NOT NULL', [queued.turnId])).rowCount, 3);
});

test('partial delivery retries only unfinished bubbles after restart, preserving keys and the generated image', async () => {
  const queued = await prepareFirstDesign(store, incoming(), 'linq');
  const image: Attachment = { id: randomUUID(), url: '/test-image', mimeType: 'image/jpeg', filename: 'design.jpg', sizeBytes: 4 };
  let modelCalls = 0; let renders = 0; let attempts = 0;
  const accepted = new Map<string, string>(); const keys: string[] = [];
  const transport: Messenger = { ...messenger, async send(chat, value, key, files) {
    if (value.includes('working on your kitchen')) return 'progress';
    keys.push(key); accepted.set(key, value);
    if (++attempts === 2) throw new Error('Provider accepted bubble but connection was lost');
    return messenger.send(chat, value, key, files);
  } };
  const agent: Agent = { async respond(ctx) { modelCalls++; return confirmedDesign(ctx, decision({ reply: text,
    brief: { ...decision().brief, propertyAddress: '123 Example St' }, handoff: { kind: 'design', summary: 'Warm oak' } })); } };
  const design = { async generate() { renders++; return [image]; } };
  const worker = (db: Store) => new Worker(db, agent, transport, logger, 100, 'live', design);
  await worker(store).tick();
  assert.equal((await store.context(queued.conversationId!))!.messages.at(-1)!.text, pieces[0]);
  await pool.query("UPDATE turns SET lease_until=now()-interval '1 second',available_at=now() WHERE id=$1", [queued.turnId]);
  signals.length = 0;
  await worker(new Store(pool, 0)).tick();
  assert.deepEqual(signals, []);
  assert.equal(modelCalls, 1); assert.equal(renders, 1);
  assert.equal(accepted.size, 3); assert.equal(keys.length, 4); assert.equal(keys[1], keys[2]);
  assert.equal(keys.filter((key) => key === queued.turnId).length, 1);
  assert.deepEqual(sent.filter((item) => item.files.length).map((item) => item.files), [[image]]);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
  assert.equal((await store.context(queued.conversationId!))!.messages.at(-1)!.text, text);
});

for (const interruption of ['pause', 'reset', 'new input'] as const) test(`${interruption} between texts suppresses remaining bubbles and keeps only delivered text`, async () => {
  const message = incoming(); const queued = await store.ingest(message, 'linq');
  await runner(model, { ...messenger, async send(chat, text, key, files) {
    const receipt = await messenger.send(chat, text, key, files);
    if (interruption === 'pause') await store.pause(queued.conversationId!, true);
    else await store.ingest(incoming({ chatId: message.chatId, text: interruption === 'reset' ? '/new' : 'Actually, use green cabinets' }), 'linq', true);
    return receipt;
  } }).tick();
  assert.deepEqual(sent.map((item) => item.text), [pieces[0]]);
  assert.equal(signals.at(-1), false);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'cancelled');
  assert.equal((await store.context(queued.conversationId!))!.messages.find((item) => item.role === 'assistant')!.text, pieces[0]);
});

test('typing clears on silence and failure, and a typing outage never blocks a reply', async () => {
  const silent = await store.ingest(incoming(), 'linq');
  await runner({ async respond() { return decision({ reply: null }); } }).tick();
  assert.equal(sent.length, 0); assert.equal(signals.at(-1), false);
  assert.equal((await store.getTurn(silent.turnId!))?.status, 'done');
  await store.ingest(incoming(), 'linq');
  await runner({ async respond() { throw new Error('Unavailable'); } }).tick();
  assert.equal(signals.at(-1), false);
  await store.ingest(incoming(), 'linq');
  await runner({ async respond() { return decision({ reply: 'Got it.' }); } }, {
    ...messenger, async typing() { throw new Error('Typing unavailable'); },
  }).tick();
  assert.equal(sent.at(-1)!.text, 'Got it.');
});

test('sandbox never sends real texts or typing indicators', async () => {
  const queued = await store.ingest(incoming(), 'sandbox');
  await runner().tick();
  assert.deepEqual(sent, []); assert.deepEqual(signals, []);
  assert.equal((await store.context(queued.conversationId!))!.messages.at(-1)!.text, text);
});

test('the intake checkpoint becomes available only after the last question bubble is delivered', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  let bubbles = 0;
  await runner({ async respond() { return decision({ reply: `${pieces[0]} ${pieces[1]}`, brief: readyBrief(),
    intakeConfirmation: { action: 'ask', messageId: null } }); } }, { ...messenger, async send(chat, text, key, files) {
    bubbles++;
    assert.equal((await store.context(queued.conversationId!))?.intakeCheckpoint, null);
    return messenger.send(chat, text, key, files);
  } }).tick();
  assert.ok(bubbles > 1);
  assert.ok(sent.at(-1)!.text.endsWith(intakeQuestion));
  assert.ok((await store.context(queued.conversationId!))?.intakeCheckpoint?.text.endsWith(intakeQuestion));
});

test('a pause clears typing while the model is still running and suppresses its eventual reply', async () => {
  const queued = await store.ingest(incoming(), 'linq');
  let release!: () => void; let cleared!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const thinking = deferred();
  const stopped = new Promise<void>((resolve) => { cleared = resolve; });
  const running = runner({ async respond() { await gate; return decision(); } }, {
    ...messenger, async typing(_chat, active) { signals.push(active); if (active) thinking.resolve(); else cleared(); },
  }).tick();
  try {
    await deadline(thinking.promise); assert.equal(signals.at(-1), true);
    await store.pause(queued.conversationId!, true);
    await Promise.race([stopped, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Typing did not clear')), 5000).unref())]);
    assert.equal(signals.at(-1), false); assert.equal(sent.length, 0);
  } finally { release(); await running; }
  assert.equal(sent.length, 0);
});

test('a recovered older decision keeps its original single-message payload and idempotency key', async () => {
  const queued = await store.ingest(incoming(), 'linq'); const claim = await store.claim(); assert.ok(claim);
  await store.saveDecision(claim.turn.id, decision({ reply: text })); await store.release(claim);
  await pool.query("UPDATE turns SET lease_until=now()-interval '1 second' WHERE id=$1", [queued.turnId]);
  await runner({ async respond() { assert.fail('Do not regenerate a saved reply'); } }).tick();
  assert.deepEqual(sent.map(({ text, key }) => ({ text, key })), [{ text, key: queued.turnId }]);
  assert.deepEqual(signals, []);
});

for (const blocked of ['typing start', 'typing stop', 'reaction'] as const) test(`a slow ${blocked} does not delay thinking or ready text bubbles`, async () => {
  const queued = await store.ingest(incoming(), 'linq');
  const pending = deferred(); const started = deferred(); const delivered = deferred();
  const transport: Messenger = {
    async typing(_chat, active) {
      signals.push(active);
      if (active) started.resolve();
      if (blocked === (active ? 'typing start' : 'typing stop')) await pending.promise;
    },
    async react() { if (blocked === 'reaction') await pending.promise; },
    async send(chat, text, key, files) {
      const receipt = await messenger.send(chat, text, key, files);
      if (sent.length === pieces.length) delivered.resolve();
      return receipt;
    },
  };
  const running = runner({ async respond() {
    // The model and presence start independently, even when the start API hangs.
    await started.promise;
    return decision({ reply: text, reaction: '👍' });
  } }, transport).tick();
  try {
    await deadline(delivered.promise);
    assert.deepEqual(sent.map((item) => item.text), pieces);
    assert.equal(signals.filter(Boolean).length, 1);
  } finally { pending.resolve(); await running; }
  assert.deepEqual(signals, [true, false]);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});

test('a saved decision starts typing only when its image still needs to be generated', async () => {
  const queued = await prepareFirstDesign(store, incoming(), 'linq');
  const claim = await store.claim(); assert.ok(claim);
  const ctx = (await store.context(queued.conversationId!))!;
  await store.saveDecision(claim.turn.id, confirmedDesign(ctx, decision({ reply: text,
    brief: readyBrief(), handoff: { kind: 'design', summary: 'Warm oak' } })));
  await store.release(claim);
  await pool.query("UPDATE turns SET lease_until=now()-interval '1 second' WHERE id=$1", [queued.turnId]);
  const thinking = deferred();
  await new Worker(store, { async respond() { assert.fail('Use the saved decision'); } }, {
    ...messenger, async typing(chat, active) { await messenger.typing!(chat, active); if (active) thinking.resolve(); },
    async send(chat, text, key, files) {
      if (text.includes('working on your kitchen')) { assert.deepEqual(signals, []); return 'progress'; }
      return messenger.send(chat, text, key, files);
    },
  }, logger, 100, 'live', { async generate() { await thinking.promise; return []; } }).tick();
  assert.deepEqual(signals, [true, false]);
  assert.equal((await store.getTurn(queued.turnId!))?.status, 'done');
});
