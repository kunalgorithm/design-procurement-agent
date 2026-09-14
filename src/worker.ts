import type { Logger } from 'pino';
import type { Agent, Attachment, Decision, Messenger } from './domain.js';
import { designReview, reactionTarget, validateDecision } from './domain.js';
import { shouldGenerateKitchen, type DesignStudio } from './design.js';
import { Store, type Turn } from './store.js';

export function classifyError(error: unknown, stage?: string) {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
  // Keep useful provider diagnostics without logging prompts, image URLs, or error bodies.
  const field = (name: string) => {
    const value = error && typeof error === 'object' ? (error as Record<string, unknown>)[name] : undefined;
    return typeof value === 'string' && /^[\w.-]{1,200}$/.test(value) ? value : undefined;
  };
  const providerCode = field('code');
  const imageUnavailable = stage === 'image_generation' && ([401, 403].includes(status ?? 0)
    || providerCode === 'model_not_found' || providerCode === 'insufficient_quota' || providerCode === 'billing_hard_limit_reached');
  return {
    code: imageUnavailable ? 'IMAGE_GENERATION_UNAVAILABLE' : status ? `UPSTREAM_${status}` : 'PROCESSING_FAILED',
    permanent: imageUnavailable || !!status && status >= 400 && status < 500 && ![408,409,429].includes(status),
    status, providerCode, requestId: field('requestID') ?? field('request_id'), param: field('param'),
  };
}

export class Worker {
  private running = false;
  private timers = new Set<NodeJS.Timeout>();
  private active = new Set<Promise<void>>();
  constructor(private readonly store: Store, private readonly agent: Agent,
    private readonly messenger: Messenger, private readonly logger: Logger,
    private readonly pollMs: number, private readonly mode: 'sandbox' | 'live',
    private readonly design?: DesignStudio, private readonly concurrency = 3) {}

  private async cancelled(turn: Turn) {
    const conversation = await this.store.getConversation(turn.conversation_id);
    const current = await this.store.getTurn(turn.id);
    return !conversation || !current || !!conversation.archived_at || current.status === 'cancelled'
      || (turn.kind === 'agent' && conversation.paused);
  }

  private async sendUpdate(turn: Turn, phase: 'progress' | 'failure', text: string) {
    const update = await this.store.prepareUpdate(turn, phase, text);
    if (update.sent_at || await this.cancelled(turn)) return;
    const conversation = await this.store.getConversation(turn.conversation_id);
    if (!conversation) return;
    let externalId: string | null = null;
    if (conversation.channel === 'linq') {
      if (this.mode !== 'live') throw Object.assign(new Error('LIVE_SEND_DISABLED'), { status: 403 });
      externalId = await this.messenger.send(conversation.external_id, update.text, update.id);
    }
    await this.store.recordUpdate(turn, update, externalId);
  }

  async tick(): Promise<boolean> {
    const claim = await this.store.claim();
    if (!claim) return false;
    const { turn } = claim;
    let stage = 'agent';
    try {
      if (turn.status === 'failed') {
        if (await this.store.hasNewerCompletedTurn(turn)) { await this.store.finishFailureNotice(turn); return true; }
        try {
          await this.sendUpdate(turn, 'failure', turn.generated_attachments?.length
            ? "Your design is saved, but I couldn’t finish sending it. Reply ‘try again’ to resend it."
            : turn.last_error === 'IMAGE_GENERATION_UNAVAILABLE'
              ? "Image generation is temporarily unavailable. Your photos and request are saved."
              : "I couldn’t finish that request. Reply ‘try again’ to retry it, or send an updated request.");
          await this.store.finishFailureNotice(turn);
        } catch {
          await this.store.finishFailureNotice(turn, true);
          this.logger.warn({ turnId: turn.id }, 'Failure update could not be sent');
        }
        return true;
      }
      const context = await this.store.context(turn.conversation_id, turn.through_seq);
      if (!context) throw new Error('CONVERSATION_MISSING');
      if (await this.cancelled(turn)) { await this.store.cancel(turn); return true; }
      const decision: Decision = turn.decision ?? (turn.kind !== 'agent'
        ? { reply: turn.operator_text, brief: context.conversation.brief, handoff: null }
        : validateDecision(await this.agent.respond(context), context));
      if (!turn.decision) await this.store.saveDecision(turn.id, decision);
      // A STOP or operator pause can arrive while the model is running.
      if (await this.cancelled(turn)) {
        await this.store.cancel(turn); return true;
      }
      const target = reactionTarget(context);
      if (turn.kind === 'agent' && decision.reaction && target && this.mode === 'live'
        && this.messenger.react && await this.store.claimReaction(turn.id)) {
        try { await this.messenger.react(target, decision.reaction); }
        catch (error) {
          this.logger.warn({ turnId: turn.id, code: classifyError(error).code }, 'Reaction failed; continuing with reply');
        }
      }
      let output: Decision = decision;
      let attachments: Attachment[] = turn.generated_attachments ?? [];
      if (turn.kind === 'agent' && this.design && shouldGenerateKitchen(output)) {
        if (!turn.generated_attachments) {
          try { await this.sendUpdate(turn, 'progress', "I’m working on your kitchen design. I’ll share the image here when it’s ready."); }
          catch { this.logger.warn({ turnId: turn.id }, 'Progress update could not be sent'); }
          if (await this.cancelled(turn)) { await this.store.cancel(turn); return true; }
          stage = 'image_generation';
          try { attachments = await this.design.generate(context, output); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== 'REFERENCE_IMAGES_UNAVAILABLE') throw error;
            output = { ...output, handoff: null, reply: "I couldn’t reopen a usable reference image. Please send a JPEG or PNG of the kitchen or the design you want changed." };
            await this.store.saveDecision(turn.id, output);
          }
          await this.store.saveGeneratedAttachments(turn.id, attachments);
        }
        if (!output.reply && attachments.length) {
          output = { ...output, reply: designReview(context).count === 0
            ? "Here’s a first design for your kitchen. What do you think? Let me know if you’d like to make any changes."
            : "Here’s your updated design. Would you like to finalize it so your contractor can order materials and plan the work?" };
        }
      }
      let externalId: string | null = null;
      stage = 'delivery';
      // A reaction or image generation may take time; honor a pause received while waiting.
      if (await this.cancelled(turn)) {
        await this.store.cancel(turn); return true;
      }
      if ((output.reply || attachments.length) && context.conversation.channel === 'linq') {
        if (this.mode !== 'live') throw Object.assign(new Error('LIVE_SEND_DISABLED'), { status: 403 });
        externalId = await this.messenger.send(context.conversation.external_id, output.reply ?? '', turn.id, attachments);
      }
      await this.store.finish(turn, output, externalId, attachments);
      this.logger.info({ turnId: turn.id, conversationId: turn.conversation_id, handoff: output.handoff?.kind, images: attachments.length }, 'Turn completed');
    } catch (error) {
      const failure = classifyError(error, stage);
      await this.store.fail(turn, failure.code, failure.permanent);
      this.logger.error({ turnId: turn.id, attempt: turn.attempts, stage, ...failure }, 'Turn failed');
    } finally { await this.store.release(claim); }
    return true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const poll = () => {
      const task = (async () => {
        let didWork = false;
        try { didWork = await this.tick(); }
        catch { this.logger.error('Queue polling failed'); }
        if (this.running) {
          const timer = setTimeout(() => { this.timers.delete(timer); poll(); }, didWork ? 10 : this.pollMs);
          this.timers.add(timer);
        }
      })();
      this.active.add(task);
      void task.finally(() => this.active.delete(task));
    };
    for (let i = 0; i < this.concurrency; i++) poll();
  }
  async stop() {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.active);
  }
}
