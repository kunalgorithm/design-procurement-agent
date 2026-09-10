import { z } from 'zod';

const detail = z.string().max(2000).nullable();
export const briefSchema = z.object({
  homeownerName: detail,
  contractorName: detail,
  propertyAddress: detail,
  scope: detail,
  goals: z.array(z.string().max(500)).max(20),
  style: detail,
  materials: z.array(z.string().max(500)).max(20),
  appliances: z.array(z.string().max(500)).max(20),
  budget: detail,
  timeline: detail,
  reportedMeasurements: detail,
  constraints: z.array(z.string().max(500)).max(20),
  openQuestions: z.array(z.string().max(500)).max(20),
});
export type Brief = z.infer<typeof briefSchema>;
export const emptyBrief = (): Brief => ({
  homeownerName: null, contractorName: null, propertyAddress: null, scope: null,
  goals: [], style: null, materials: [], appliances: [], budget: null, timeline: null,
  reportedMeasurements: null, constraints: [], openQuestions: [],
});

export const taskKindSchema = z.enum(['design', 'proposal', 'procurement', 'human']);
export type TaskKind = z.infer<typeof taskKindSchema>;
export const decisionSchema = z.object({
  reply: z.string().max(3000).nullable(),
  brief: briefSchema,
  handoff: z.object({ kind: taskKindSchema, summary: z.string().min(1).max(2000) }).nullable(),
});
export type Decision = z.infer<typeof decisionSchema>;

export const attachmentSchema = z.object({
  id: z.string().max(200), url: z.string().url().max(4096),
  mimeType: z.string().max(200), filename: z.string().max(500),
  sizeBytes: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof attachmentSchema>;
export interface IncomingMessage {
  eventId: string; messageId: string; chatId: string; sender: string;
  owner: string | null; isGroup: boolean; service: string;
  text: string; attachments: Attachment[]; sentAt: string;
}
export interface Conversation {
  id: string; external_id: string; channel: 'linq' | 'sandbox';
  is_group: boolean; owner_handle: string | null; paused: boolean;
  brief: Brief; created_at: Date; updated_at: Date;
}
export interface Message {
  id: string; seq: string; conversation_id: string;
  role: 'user' | 'assistant' | 'operator'; sender: string;
  text: string; attachments: Attachment[]; created_at: Date;
}
export interface Handoff {
  id: string; kind: TaskKind; summary: string; status: 'open' | 'completed';
}
export interface AgentContext { conversation: Conversation; messages: Message[]; handoffs: Handoff[] }
export interface Agent { respond(context: AgentContext): Promise<Decision> }
export interface Messenger { send(chatId: string, text: string, idempotencyKey: string): Promise<string> }

export const isStopRequest = (text: string) => /^(stop|unsubscribe|cancel|end|quit|stop all|opt[ -]?out)[.!\s]*$/i.test(text.trim());

export function validateDecision(decision: Decision, context: AgentContext): Decision {
  const parsed = decisionSchema.parse(decision);
  if (parsed.handoff && parsed.handoff.kind !== 'human') {
    const brief = parsed.brief;
    if (!brief.contractorName || !brief.homeownerName || !brief.propertyAddress || !brief.scope) {
      // Never announce a handoff that cannot be queued with useful project context.
      return { ...parsed, handoff: null, reply: 'Before I hand this over, please confirm the contractor and homeowner names, property address, and the work you want done.' };
    }
    if (context.handoffs.some((task) => task.kind === parsed.handoff!.kind && task.status === 'open')) {
      parsed.handoff = null;
    }
  }
  return parsed;
}
