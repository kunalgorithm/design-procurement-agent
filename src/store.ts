import type pg from 'pg';
import type { MediaFile } from './media.js';
import type { z } from 'zod';
import type { contractorSignupSchema } from './contractor-schema.js';
import { transaction } from './db.js';
import { parseChatCommand, type ChatCommand } from './chat-commands.js';
import { emptyBrief, isStopRequest, type IncomingMessage, type Conversation, type Message, type Handoff, type Decision, type AgentContext, type Attachment } from './domain.js';

export interface Turn {
  id: string; conversation_id: string; kind: 'agent' | 'operator' | 'control';
  through_seq: string; status: string; decision: Decision | null;
  generated_attachments: Attachment[] | null; failure_notified_at: Date | null; notification_attempts: number;
  operator_text: string | null; attempts: number; last_error: string | null;
}
export interface ClaimedTurn { turn: Turn; client: pg.PoolClient; lockKey: string }

export class Store {
  constructor(readonly pool: pg.Pool, private readonly debounceMs = 1500) {}

  async readMedia(id: string): Promise<MediaFile | null> {
    return (await this.pool.query<MediaFile>('SELECT bytes,mime_type AS "mimeType",filename FROM project_media WHERE id=$1', [id])).rows[0] ?? null;
  }
  async saveMedia(conversationId: string, attachment: Attachment, bytes: Buffer) {
    await this.pool.query(`INSERT INTO project_media(id,conversation_id,mime_type,filename,bytes) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO NOTHING`, [attachment.id, conversationId, attachment.mimeType, attachment.filename, bytes]);
  }
  async providerAttachment(id: string) {
    return (await this.pool.query<{ provider_attachment_id: string | null }>('SELECT provider_attachment_id FROM project_media WHERE id=$1', [id])).rows[0]?.provider_attachment_id ?? null;
  }
  async saveProviderAttachment(id: string, providerId: string) {
    await this.pool.query('UPDATE project_media SET provider_attachment_id=$2 WHERE id=$1', [id, providerId]);
  }
  async registerContractor(input: z.infer<typeof contractorSignupSchema>, agentPhone: string) {
    const result = await this.pool.query<{ agent_phone: string }>(`
      INSERT INTO contractor_signups(id,first_name,last_name,phone,email,website,license_number,agent_phone)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(id) DO UPDATE SET id=contractor_signups.id
      RETURNING agent_phone`, [input.submissionId, input.firstName, input.lastName, input.phone,
      input.email, input.website ?? null, input.licenseNumber ?? null, agentPhone]);
    return result.rows[0]!;
  }

  private async duplicateReceipt(client: pg.PoolClient, message: IncomingMessage, channel: string) {
    const original = (await client.query(`SELECT m.*,c.external_id AS chat_id,c.paused,
      (SELECT id FROM turns WHERE conversation_id=c.id AND ((kind='agent' AND through_seq>=m.seq) OR (kind='control' AND through_seq=m.seq))
        ORDER BY (kind='control') DESC,queue_order LIMIT 1) AS turn_id
      FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.external_id=$1`, [`${channel}:${message.messageId}`])).rows[0];
    if (channel === 'sandbox' && original && (original.chat_id !== message.chatId || original.text !== message.text || original.sender !== message.sender)) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    return { duplicate: true, conversationId: original?.conversation_id as string | undefined,
      turnId: original?.turn_id as string | undefined, paused: original?.paused as boolean | undefined };
  }

  async ingest(message: IncomingMessage, channel: 'linq' | 'sandbox', adminAuthorized = false) {
    const command = channel === 'linq' ? parseChatCommand(message.text) : null;
    return transaction(this.pool, async (client) => {
      // Serialize routing through a reset, without waiting for the model or outbound sends.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${channel}:ingest:${message.chatId}`]);
      const seen = await client.query('INSERT INTO webhook_events(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id', [`${channel}:${message.eventId}`]);
      if (!seen.rowCount) return this.duplicateReceipt(client, message, channel);
      const result = await client.query<Conversation>(`INSERT INTO conversations(external_id,channel,is_group,owner_handle,brief)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(channel,external_id) WHERE archived_at IS NULL DO UPDATE SET updated_at=now()
        RETURNING *`, [message.chatId, channel, message.isGroup, message.owner, JSON.stringify(emptyBrief())]);
      const conversation = result.rows[0]!;
      const inserted = await client.query<Message>(`INSERT INTO messages(conversation_id,external_id,role,sender,text,attachments,provider_sent_at,service,is_control)
        VALUES($1,$2,'user',$3,$4,$5,$6,$7,$8) ON CONFLICT(external_id) DO NOTHING RETURNING *`,
      [conversation.id, `${channel}:${message.messageId}`, message.sender, message.text, JSON.stringify(message.attachments), message.sentAt, message.service, !!command]);
      if (!inserted.rowCount) return this.duplicateReceipt(client, message, channel);
      if (command) return this.handleCommand(client, conversation, inserted.rows[0]!, command, adminAuthorized);
      if (isStopRequest(message.text)) {
        await client.query('UPDATE conversations SET paused=true WHERE id=$1', [conversation.id]);
        await client.query("UPDATE turns SET status='cancelled',completed_at=now() WHERE conversation_id=$1 AND kind='agent' AND status IN ('pending','processing','failed')", [conversation.id]);
        return { conversationId: conversation.id, paused: true };
      }
      if (conversation.paused) return { conversationId: conversation.id, paused: true };
      if (!message.attachments.length && /^(?:please\s+)?(?:try again|retry|resend)(?:\s+please)?[.!?\s]*$/i.test(message.text.trim())) {
        const latest = (await client.query<Turn>("SELECT * FROM turns WHERE conversation_id=$1 AND kind!='control' ORDER BY queue_order DESC LIMIT 1", [conversation.id])).rows[0];
        if (latest?.kind === 'agent' && latest.status === 'failed') {
          const retried = await this.retryWithClient(client, latest.id, inserted.rows[0]!.seq);
          if (retried) return { conversationId: conversation.id, turnId: retried.id, duplicate: false };
        }
      }
      const turn = await client.query<Turn>(`INSERT INTO turns(conversation_id,through_seq,available_at)
        VALUES($1,$2,now()+($3 * interval '1 millisecond'))
        ON CONFLICT(conversation_id) WHERE status='pending' AND kind='agent'
        DO UPDATE SET through_seq=GREATEST(turns.through_seq,EXCLUDED.through_seq),available_at=EXCLUDED.available_at
        RETURNING *`, [conversation.id, inserted.rows[0]!.seq, this.debounceMs]);
      return { conversationId: conversation.id, turnId: turn.rows[0]!.id, duplicate: false };
    });
  }

  private async handleCommand(client: pg.PoolClient, conversation: Conversation, message: Message, command: ChatCommand, authorized: boolean) {
    let current = conversation;
    let reply: string;
    if (!authorized) {
      reply = 'That command is available only to FORM admins.';
    } else if (message.attachments.length) {
      reply = 'Send the command on its own, without attachments.';
    } else if (command === 'reset') {
      await client.query('UPDATE conversations SET archived_at=now(),paused=true,updated_at=now() WHERE id=$1', [current.id]);
      await client.query("UPDATE turns SET status='cancelled',completed_at=now(),lease_until=NULL WHERE conversation_id=$1 AND status IN ('pending','processing','failed')", [current.id]);
      current = (await client.query<Conversation>(`INSERT INTO conversations(external_id,channel,is_group,owner_handle,brief)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [current.external_id,current.channel,current.is_group,current.owner_handle,JSON.stringify(emptyBrief())])).rows[0]!;
      await client.query('UPDATE messages SET conversation_id=$2 WHERE id=$1', [message.id,current.id]);
      reply = 'Started a fresh conversation.';
    } else if (command === 'pause' || command === 'resume') {
      const paused = command === 'pause';
      current = (await client.query<Conversation>('UPDATE conversations SET paused=$2,updated_at=now() WHERE id=$1 RETURNING *', [current.id,paused])).rows[0]!;
      if (paused) await client.query("UPDATE turns SET status='cancelled',completed_at=now(),lease_until=NULL WHERE conversation_id=$1 AND kind='agent' AND status IN ('pending','processing','failed')", [current.id]);
      reply = paused ? 'FORM is paused in this chat. Send /resume to continue.' : 'FORM is active in this chat. Send your next message when you’re ready.';
    } else {
      const counts = (await client.query<{ working: number; queued: number; failed: number }>(`SELECT
        count(*) FILTER (WHERE status='processing')::int AS working,
        count(*) FILTER (WHERE status='pending')::int AS queued,
        count(*) FILTER (WHERE status='failed')::int AS failed
        FROM turns WHERE conversation_id=$1 AND kind='agent'`, [current.id])).rows[0]!;
      const handoffs = (await client.query<Handoff>("SELECT kind FROM handoffs WHERE conversation_id=$1 AND status='open' ORDER BY created_at", [current.id])).rows;
      reply = `FORM is ${current.paused ? 'paused' : 'active'} in this chat. Requests: ${counts.working} working, ${counts.queued} queued, ${counts.failed} failed. Open handoffs: ${handoffs.map((task) => task.kind).join(', ') || 'none'}.`;
    }
    const turn = (await client.query<Turn>(`INSERT INTO turns(conversation_id,kind,through_seq,operator_text)
      VALUES($1,'control',$2,$3) RETURNING *`, [current.id,message.seq,reply])).rows[0]!;
    return { conversationId: current.id, turnId: turn.id, paused: current.paused, command, authorized, duplicate: false };
  }

  async getConversation(id: string) {
    return (await this.pool.query<Conversation>('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];
  }
  async listConversations(archived = false) {
    return (await this.pool.query<Conversation>('SELECT * FROM conversations WHERE (archived_at IS NOT NULL)=$1 ORDER BY updated_at DESC LIMIT 100', [archived])).rows;
  }
  async context(id: string, throughSeq?: string, includeControls = false): Promise<AgentContext | undefined> {
    const conversation = await this.getConversation(id);
    if (!conversation) return undefined;
    const messages = await this.pool.query<Message>(`SELECT * FROM (
      SELECT * FROM messages WHERE conversation_id=$1 AND ($2::bigint IS NULL OR seq <= $2 OR role != 'user')
      AND (NOT is_control OR $3) ORDER BY seq DESC LIMIT 40) history ORDER BY seq`, [id, throughSeq ?? null,includeControls]);
    const handoffs = await this.pool.query<Handoff>('SELECT * FROM handoffs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 30', [id]);
    // Search the full history so a long conversation cannot trigger another introduction.
    const replied = await this.pool.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM messages WHERE conversation_id=$1 AND role='assistant' AND NOT is_control)", [id]);
    const references = await this.pool.query<Message>(`SELECT * FROM (
      (SELECT * FROM messages WHERE conversation_id=$1 AND role!='assistant' AND NOT is_control AND jsonb_array_length(attachments)>0
        AND ($2::bigint IS NULL OR seq<=$2) ORDER BY seq DESC LIMIT 16)
      UNION ALL
      (SELECT * FROM messages WHERE conversation_id=$1 AND role='assistant' AND NOT is_control AND jsonb_array_length(attachments)>0
        ORDER BY seq DESC LIMIT 1)
    ) refs ORDER BY seq`, [id, throughSeq ?? null]);
    return { conversation, messages: messages.rows, handoffs: handoffs.rows, referenceMessages: references.rows, hasAssistantReply: replied.rows[0]!.exists };
  }
  async pause(id: string, paused: boolean) {
    return transaction(this.pool, async (client) => {
      const result = await client.query<Conversation>('UPDATE conversations SET paused=$2,updated_at=now() WHERE id=$1 AND archived_at IS NULL RETURNING *', [id, paused]);
      if (paused) await client.query("UPDATE turns SET status='cancelled',completed_at=now() WHERE conversation_id=$1 AND kind='agent' AND status IN ('pending','processing','failed')", [id]);
      return result.rows[0];
    });
  }
  async queueOperator(id: string, text: string, requestId: string) {
    const result = await this.pool.query<Turn>(`INSERT INTO turns(id,conversation_id,kind,through_seq,operator_text)
      SELECT $1,id,'operator',0,$3 FROM conversations WHERE id=$2 AND archived_at IS NULL
      ON CONFLICT(id) DO NOTHING RETURNING *`, [requestId,id,text]);
    const turn = result.rows[0] ?? await this.getTurn(requestId);
    if (turn && (turn.conversation_id !== id || turn.operator_text !== text)) throw new Error('IDEMPOTENCY_CONFLICT');
    return turn;
  }
  async getTurn(id: string) { return (await this.pool.query<Turn>('SELECT * FROM turns WHERE id=$1', [id])).rows[0]; }
  async listTurns(status?: string) {
    return (await this.pool.query<Turn>('SELECT * FROM turns WHERE ($1::text IS NULL OR status=$1) ORDER BY queue_order DESC LIMIT 100', [status ?? null])).rows;
  }
  async listConversationTurns(id: string, status?: string) {
    return (await this.pool.query<Turn>('SELECT * FROM turns WHERE conversation_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY queue_order DESC LIMIT 20', [id, status ?? null])).rows;
  }
  async clearConversation(id: string, channel: 'linq' | 'sandbox' = 'sandbox') {
    return transaction(this.pool, async (client) => {
      const conversation = (await client.query<Conversation>('SELECT * FROM conversations WHERE id=$1 AND channel=$2 FOR UPDATE', [id, channel])).rows[0];
      if (!conversation) return null;
      await client.query('DELETE FROM webhook_events WHERE id IN (SELECT external_id FROM messages WHERE conversation_id=$1 AND external_id IS NOT NULL)', [id]);
      await client.query('DELETE FROM project_media WHERE conversation_id=$1', [id]);
      await client.query('DELETE FROM handoffs WHERE conversation_id=$1', [id]);
      await client.query('DELETE FROM turns WHERE conversation_id=$1', [id]);
      await client.query('DELETE FROM messages WHERE conversation_id=$1', [id]);
      return (await client.query<Conversation>('UPDATE conversations SET brief=$2,paused=false,updated_at=now() WHERE id=$1 RETURNING *',
        [id, JSON.stringify(emptyBrief())])).rows[0];
    });
  }
  private async retryWithClient(client: pg.PoolClient, id: string, throughSeq?: string) {
    // Explicit retries keep the design and final-message key, but get fresh progress/failure updates.
    const turn = (await client.query<Turn>(`UPDATE turns SET status='processing',lease_until=now()-interval '1 second',
      through_seq=COALESCE($2::bigint,through_seq),
      available_at=now(),attempts=0,last_error=NULL,failure_notified_at=NULL,notification_attempts=0 WHERE id=$1 AND status='failed'
      AND NOT EXISTS(SELECT 1 FROM turns newer WHERE newer.conversation_id=turns.conversation_id AND newer.queue_order>turns.queue_order
        AND (newer.kind!='control' OR turns.kind='control') AND newer.status IN ('done','processing')) RETURNING *`, [id, throughSeq ?? null])).rows[0];
    if (turn) await client.query('DELETE FROM turn_updates WHERE turn_id=$1', [id]);
    return turn;
  }
  async retryTurn(id: string) {
    return transaction(this.pool, (client) => this.retryWithClient(client, id));
  }
  async listHandoffs() { return (await this.pool.query("SELECT h.* FROM handoffs h JOIN conversations c ON c.id=h.conversation_id WHERE h.status='open' AND c.archived_at IS NULL ORDER BY h.created_at LIMIT 100")).rows; }
  async completeHandoff(id: string) {
    return (await this.pool.query("UPDATE handoffs SET status='completed',completed_at=now() WHERE id=$1 RETURNING *", [id])).rows[0];
  }

  async claim(): Promise<ClaimedTurn | null> {
    const candidates = await this.pool.query<Turn>(`SELECT t.* FROM turns t JOIN conversations c ON c.id=t.conversation_id
      WHERE (t.status='pending' OR (t.status='processing' AND t.lease_until < now()) OR (t.status='failed' AND t.kind='agent' AND t.failure_notified_at IS NULL))
      AND t.available_at<=now() AND c.archived_at IS NULL AND (NOT c.paused OR t.kind IN ('operator','control'))
      AND NOT EXISTS (SELECT 1 FROM turns older WHERE older.conversation_id=t.conversation_id
        AND older.queue_order<t.queue_order AND older.status IN ('pending','processing') AND (t.kind!='control' OR older.kind='control'))
      ORDER BY t.queue_order LIMIT 20`);
    for (const candidate of candidates.rows) {
      const client = await this.pool.connect();
      const lockKey = candidate.kind === 'control' ? `${candidate.conversation_id}:control` : candidate.conversation_id;
      let locked = false;
      try {
        locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lockKey])).rows[0]!.locked;
        if (!locked) { client.release(); continue; }
        const claimed = await client.query<Turn>(`UPDATE turns SET status=CASE WHEN status='failed' THEN 'failed' ELSE 'processing' END,
          attempts=attempts+CASE WHEN status='failed' THEN 0 ELSE 1 END,
          notification_attempts=notification_attempts+CASE WHEN status='failed' THEN 1 ELSE 0 END,lease_until=now()+interval '4 minutes'
          WHERE id=$1 AND (status='pending' OR (status='processing' AND lease_until<now()) OR (status='failed' AND failure_notified_at IS NULL)) RETURNING *`, [candidate.id]);
        if (claimed.rows[0]) return { turn: claimed.rows[0], client, lockKey };
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]);
        client.release();
      } catch (error) { client.release(true); throw error; }
    }
    return null;
  }
  async release(claim: ClaimedTurn) {
    try {
      await claim.client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [claim.lockKey]);
      claim.client.release();
    } catch { claim.client.release(true); }
  }
  async saveDecision(id: string, decision: Decision) {
    await this.pool.query("UPDATE turns SET decision=$2 WHERE id=$1 AND status='processing'", [id, JSON.stringify(decision)]);
  }
  async saveGeneratedAttachments(id: string, attachments: Attachment[]) {
    await this.pool.query("UPDATE turns SET generated_attachments=$2 WHERE id=$1 AND status='processing'", [id, JSON.stringify(attachments)]);
  }
  async prepareUpdate(turn: Turn, phase: 'progress' | 'failure', text: string) {
    return (await this.pool.query<{ id: string; text: string; sent_at: Date | null }>(`INSERT INTO turn_updates(turn_id,phase,text)
      VALUES($1,$2,$3) ON CONFLICT(turn_id,phase) DO UPDATE SET turn_id=EXCLUDED.turn_id RETURNING *`, [turn.id,phase,text])).rows[0]!;
  }
  async recordUpdate(turn: Turn, update: { id: string; text: string }, externalId: string | null) {
    await transaction(this.pool, async (client) => {
      await client.query(`INSERT INTO messages(id,conversation_id,external_id,role,sender,text)
        VALUES($1,$2,$3,'assistant','FORM',$4) ON CONFLICT(id) DO NOTHING`,
        [update.id,turn.conversation_id,externalId ? `outbound:${externalId}` : null,update.text]);
      await client.query('UPDATE turn_updates SET sent_at=now() WHERE id=$1', [update.id]);
    });
  }
  async hasNewerCompletedTurn(turn: Turn) {
    return (await this.pool.query(`SELECT 1 FROM turns WHERE conversation_id=$1 AND queue_order>(SELECT queue_order FROM turns WHERE id=$2) AND kind='agent' AND status='done' LIMIT 1`, [turn.conversation_id,turn.id])).rowCount! > 0;
  }
  async finishFailureNotice(turn: Turn, retry = false) {
    await this.pool.query(`UPDATE turns SET failure_notified_at=CASE WHEN $2 THEN NULL ELSE now() END,
      available_at=now()+interval '15 seconds' WHERE id=$1 AND status='failed'`, [turn.id,retry && turn.notification_attempts<3]);
  }
  async claimReaction(id: string): Promise<boolean> {
    // Reactions are best effort. Mark before sending so ambiguous failures and turn retries cannot repeat them.
    const result = await this.pool.query(`UPDATE turns t SET reaction_attempted_at=now()
      FROM conversations c WHERE t.id=$1 AND t.conversation_id=c.id AND NOT c.paused
      AND t.kind='agent' AND t.status='processing' AND t.reaction_attempted_at IS NULL RETURNING t.id`, [id]);
    return !!result.rowCount;
  }
  async finish(turn: Turn, decision: Decision, externalId: string | null, attachments: Attachment[] = []) {
    await transaction(this.pool, async (client) => {
      // Match ingest/pause lock order so STOP cannot deadlock against completion.
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [turn.conversation_id]);
      const current = (await client.query<Turn>('SELECT * FROM turns WHERE id=$1 FOR UPDATE', [turn.id])).rows[0]!;
      if (current.status === 'done') return;
      if (current.status === 'cancelled') {
        // A pause cannot recall a send already accepted by Linq. Keep its audit trail.
        if (externalId && decision.reply) await client.query(`INSERT INTO messages(id,conversation_id,external_id,role,sender,text,attachments,is_control)
          VALUES($1,$2,$3,'assistant','FORM',$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
        [turn.id, turn.conversation_id, `outbound:${externalId}`, decision.reply, JSON.stringify(attachments),turn.kind === 'control']);
        return;
      }
      if (turn.kind === 'agent') {
        await client.query('UPDATE conversations SET brief=$2,updated_at=now() WHERE id=$1', [turn.conversation_id, JSON.stringify(decision.brief)]);
      }
      if (decision.reply || attachments.length) await client.query(`INSERT INTO messages(id,conversation_id,external_id,role,sender,text,attachments,is_control)
        VALUES($1,$2,$3,$4,'FORM',$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
      [turn.id, turn.conversation_id, externalId ? `outbound:${externalId}` : null, turn.kind === 'operator' ? 'operator' : 'assistant', decision.reply ?? '', JSON.stringify(attachments),turn.kind === 'control']);
      if (decision.handoff) {
        await client.query(`INSERT INTO handoffs(conversation_id,turn_id,kind,summary) VALUES($1,$2,$3,$4)
          ON CONFLICT DO NOTHING`, [turn.conversation_id, turn.id, decision.handoff.kind, decision.handoff.summary]);
        if (decision.handoff.kind === 'design' && attachments.length) {
          await client.query(`UPDATE handoffs SET status='completed',completed_at=now()
            WHERE conversation_id=$1 AND turn_id=$2 AND kind='design' AND status='open'`, [turn.conversation_id, turn.id]);
        }
        if (decision.handoff.kind === 'human') {
          await client.query('UPDATE conversations SET paused=true WHERE id=$1', [turn.conversation_id]);
          await client.query("UPDATE turns SET status='cancelled',completed_at=now() WHERE conversation_id=$1 AND kind='agent' AND status='pending'", [turn.conversation_id]);
        }
      }
      await client.query("UPDATE turns SET status='done',completed_at=now(),lease_until=NULL,last_error=NULL WHERE id=$1", [turn.id]);
    });
  }
  async cancel(turn: Turn) {
    await this.pool.query("UPDATE turns SET status='cancelled',completed_at=now(),lease_until=NULL WHERE id=$1", [turn.id]);
  }
  async fail(turn: Turn, code: string, permanent: boolean) {
    // Leave retriable rows in processing with a future lease to avoid colliding with a newly queued pending turn.
    const terminal = permanent || turn.attempts >= 5;
    const delay = terminal ? 0 : Math.min(60000, 1000 * 2 ** turn.attempts);
    await this.pool.query(`UPDATE turns SET status=$2,last_error=$3,
      lease_until=now()+($4 * interval '1 millisecond'),available_at=now()+($4 * interval '1 millisecond') WHERE id=$1 AND status='processing'`,
    [turn.id, terminal ? 'failed' : 'processing', code, delay]);
  }
}
