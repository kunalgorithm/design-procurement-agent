export type ChatCommand = 'reset' | 'pause' | 'resume' | 'status' | 'contractor' | 'client';

export function parseChatCommand(text: string): ChatCommand | null {
  const name = /^\/(reset|new|pause|resume|status|contractor|client)\s*$/i.exec(text.trim())?.[1]?.toLowerCase();
  return name === 'new' ? 'reset' : (name as ChatCommand | undefined) ?? null;
}

export function normalizePhoneNumber(value: string): string | null {
  // Require an international phone handle; never match names, emails, or a number embedded in text.
  if (!/^\+[\d ().-]+$/.test(value.trim())) return null;
  const phone = value.trim().replace(/[ ().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
