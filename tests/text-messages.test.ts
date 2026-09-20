import test from 'node:test';
import assert from 'node:assert/strict';
import Linq from '@linqapp/sdk';
import { splitTextMessages } from '../src/text-messages.js';
import { TypingSession } from '../src/typing.js';
import { LinqMessenger } from '../src/linq.js';

test('short replies stay together and longer replies split at complete thoughts', () => {
  assert.deepEqual(splitTextMessages('Got it—warm oak and brass. 😊'), ['Got it—warm oak and brass. 😊']);
  const first = 'I can see the sink under the window and the range on the adjoining wall, with two cabinet runs meeting at one corner.';
  const second = 'We can keep that L-shaped layout and brighten the room with warm oak cabinets, light counters, and a simple backsplash.';
  const third = 'Do you have a floor plan or a quick sketch handy?';
  assert.deepEqual(splitTextMessages(`${first}\n\n${second}\n\n${third}`), [first, second, third]);
  assert.deepEqual(splitTextMessages(`${first} ${second}`), [first, second]);
});

test('long sentences preserve words, URLs, measurements, and emoji without truncation', () => {
  const url = `https://example.com/materials/${'oak-'.repeat(90)}`;
  const original = `${'Keep the cabinetry along the existing wall '.repeat(14)}3.5 m 👨‍👩‍👧‍👦 ${url}`;
  const parts = splitTextMessages(original);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), original.replace(/\s+/g, ' '));
  assert.ok(parts.some((part) => part.includes(url)));
  assert.ok(parts.some((part) => part.includes('👨‍👩‍👧‍👦')));
  assert.ok(parts.every(Boolean));
});

test('tiny acknowledgments stay attached to the following thought', () => {
  const thought = 'We can keep the sink under the window and use warm oak cabinetry along both of the existing walls, with a lighter countertop.';
  const question = 'Do you have a floor plan or a quick sketch with measurements handy so I can use those details when preparing your kitchen design?';
  assert.deepEqual(splitTextMessages(`Got it.\n\n${thought}\n\n${question}`), [`Got it. ${thought}`, question]);
});

test('Linq typing uses the start and stop endpoints without sending messages', async () => {
  const requests: string[] = [];
  const chat = '550e8400-e29b-41d4-a716-446655440000';
  const client = new Linq({ apiKey: 'test', maxRetries: 0, fetch: async (url, init) => {
    assert.ok(String(url).endsWith(`/chats/${chat}/typing`));
    requests.push(init!.method!);
    return new Response(null, { status: 204 });
  } });
  const messenger = new LinqMessenger(client);
  await messenger.typing(chat, true); await messenger.typing(chat, false);
  assert.deepEqual(requests, ['POST', 'DELETE']);
});

test('typing refreshes while working, stops on cancellation, and never restarts after cleanup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const signals: boolean[] = []; let active = true;
  const session = new TypingSession(async (value) => { signals.push(value); }, async () => active, (error) => { throw error; });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    await session.start();
    assert.deepEqual(signals, [true]);
    t.mock.timers.tick(60_000); await flush();
    assert.deepEqual(signals, [true, true]);
    active = false;
    t.mock.timers.tick(1000); await flush();
    assert.equal(signals.at(-1), false);
    const starts = signals.filter(Boolean).length;
    await session.stop();
    t.mock.timers.tick(120_000); await flush(); await session.refresh();
    assert.equal(signals.filter(Boolean).length, starts);
  } finally { await session.stop(); t.mock.timers.reset(); }
});

test('typing API failures stay best effort and cleanup waits for an in-flight start', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const signals: boolean[] = []; let failures = 0;
  const session = new TypingSession(async (active) => {
    signals.push(active);
    if (active) { entered(); await gate; throw new Error('Typing unavailable'); }
  }, async () => true, () => { failures++; });
  const beginning = session.start(); await started;
  const stopping = session.stop(); release();
  await Promise.all([beginning, stopping]);
  assert.deepEqual(signals, [true, false]); assert.equal(failures, 1);
});
