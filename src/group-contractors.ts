import { normalizePhoneNumber } from './chat-commands.js';

export interface RegisteredContractor {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  businessName: string | null;
  website: string | null;
}

// Only a provider-supplied phone handle can match a signup. Emails and phone
// numbers mentioned in message text never establish another participant's identity.
export function contractorMatches(rows: RegisteredContractor[]) {
  const byPhone = new Map<string, RegisteredContractor[]>();
  for (const row of rows) {
    const phone = normalizePhoneNumber(row.phone);
    if (phone) byPhone.set(phone, [...(byPhone.get(phone) ?? []), { ...row, phone }]);
  }
  const contractors: RegisteredContractor[] = [];
  const ambiguousPhones: string[] = [];
  for (const [phone, entries] of byPhone) {
    const identities = new Set(entries.map((row) => JSON.stringify([
      row.firstName.trim().toLowerCase(), row.lastName.trim().toLowerCase(),
      row.businessName?.trim().toLowerCase() ?? null, row.website,
    ])));
    if (identities.size === 1) contractors.push(entries[0]!);
    else ambiguousPhones.push(phone);
  }
  return { contractors, ambiguousPhones };
}
