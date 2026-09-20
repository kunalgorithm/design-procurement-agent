export type ChatCommand = 'help' | 'reset' | 'pause' | 'resume' | 'status' | 'contractor' | 'client';

export const adminHelpText = `FORM admin controls

/help — Show all admin commands.
/status — Show active/paused state, working/queued/failed requests, open handoffs, and your role in a private chat.
/pause — Pause automatic replies and cancel unfinished agent requests.
/resume — Resume automatic replies on your next message. Cancelled work is not replayed.
/reset or /new — Start fresh, clear the active project context, and restore your usual role.
/contractor — Start a fresh project as the contractor (private chats only).
/client — Start a fresh project as the client (private chats only).

Send each command on its own, without attachments. Controls apply to this chat; everyone here can see the replies.
Reset and role commands archive the current project and cancel unfinished work. Chat history is kept.`;

export function parseChatCommand(text: string): ChatCommand | null {
  const name = /^\/(help|reset|new|pause|resume|status|contractor|client)\s*$/i.exec(text.trim())?.[1]?.toLowerCase();
  return name === 'new' ? 'reset' : (name as ChatCommand | undefined) ?? null;
}

export function normalizePhoneNumber(value: string): string | null {
  // Require an international phone handle; never match names, emails, or a number embedded in text.
  if (!/^\+[\d ().-]+$/.test(value.trim())) return null;
  const phone = value.trim().replace(/[ ().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
