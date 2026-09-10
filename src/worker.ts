import type { Logger } from 'pino';
import type { Agent, Messenger } from './domain.js';
import { validateDecision } from './domain.js';
import { Store } from './store.js';

export function classifyError(error: unknown) {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  return {
    code: status ? `UPSTREAM_${status}` : 'PROCESSING_FAILED',
    permanent: !!status && status >= 400 && status < 500 && ![408,409,429].includes(status),
  };
}

export class Worker {
  private running = false;
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly store: Store, private readonly agent: Agent,
    private readonly messenger: Messenger, private readonly logger: Logger,
    private readonly pollMs: number, private readonly mode: 'sandbox' | 'live') {}

  async tick(): Promise<boolean> {
    const claim = await this.store.claim();
    if (!claim) return false;
    const { turn } = claim;
    try {
      const context = await this.store.context(turn.conversation_id, turn.through_seq);
      if (!context) throw new Error('CONVERSATION_MISSING');
      if (context.conversation.paused && turn.kind === 'agent') { await this.store.cancel(turn); return true; }
      const decision = turn.decision ?? (turn.kind === 'operator'
        ? { reply: turn.operator_text, brief: context.conversation.brief, handoff: null }
        : validateDecision(await this.agent.respond(context), context));
      if (!turn.decision) await this.store.saveDecision(turn.id, decision);
      // A STOP or operator pause can arrive while the model is running.
      if (turn.kind === 'agent' && ((await this.store.getConversation(turn.conversation_id))?.paused || (await this.store.getTurn(turn.id))?.status === 'cancelled')) {
        await this.store.cancel(turn); return true;
      }
      let externalId: string | null = null;
      if (decision.reply && context.conversation.channel === 'linq') {
        if (this.mode !== 'live') throw Object.assign(new Error('LIVE_SEND_DISABLED'), { status: 403 });
        externalId = await this.messenger.send(context.conversation.external_id, decision.reply, turn.id);
      }
      await this.store.finish(turn, decision, externalId);
      this.logger.info({ turnId: turn.id, conversationId: turn.conversation_id, handoff: decision.handoff?.kind }, 'Turn completed');
    } catch (error) {
      const failure = classifyError(error);
      await this.store.fail(turn, failure.code, failure.permanent);
      this.logger.error({ turnId: turn.id, attempt: turn.attempts, code: failure.code }, 'Turn failed');
    } finally { await this.store.release(claim); }
    return true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const poll = () => {
      this.active = (async () => {
        let didWork = false;
        try { didWork = await this.tick(); }
        catch { this.logger.error('Queue polling failed'); }
        if (this.running) this.timer = setTimeout(poll, didWork ? 10 : this.pollMs);
      })();
    };
    poll();
  }
  async stop() { this.running = false; clearTimeout(this.timer); await this.active; }
}
