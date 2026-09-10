import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { setTimeout } from 'node:timers/promises';

const baseUrl = process.env.AGENT_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`;
const token = process.env.ADMIN_API_KEY;
if (!token) throw new Error('Set ADMIN_API_KEY in .env');
const terminal = createInterface({ input: stdin, output: stdout });
let sessionId: string | undefined;
let sender = 'homeowner';
async function request(path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json() as any;
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
console.log('FORM sandbox. No real texts are sent. /as contractor, /as homeowner, /new, /quit');
try {
  for (;;) {
    const message = (await terminal.question(`${sender}> `)).trim();
    if (message === '/quit') break;
    if (message === '/new') { sessionId = undefined; continue; }
    if (message.startsWith('/as ')) { sender = message.slice(4); continue; }
    if (!message) continue;
    const queued = await request('/sandbox/messages', { sessionId, sender, message });
    sessionId = queued.sessionId;
    if (queued.paused) { console.log('Conversation paused. Resume through the admin API, or use /new.'); continue; }
    for (let attempt = 0; attempt < 180; attempt++) {
      await setTimeout(1000);
      const { turn } = await request(`/turns/${queued.turnId}`);
      if (turn.status === 'done') {
        console.log(`FORM> ${turn.decision?.reply ?? '(stays quiet)'}`);
        if (turn.decision?.handoff) console.log(`Handoff: ${turn.decision.handoff.kind}`);
        break;
      }
      if (['failed', 'cancelled'].includes(turn.status)) { console.log(`Turn ${turn.status}: ${turn.last_error ?? ''}`); break; }
      if (attempt === 179) console.log(`Still processing. Inspect /api/turns/${queued.turnId}`);
    }
  }
} finally { terminal.close(); }
