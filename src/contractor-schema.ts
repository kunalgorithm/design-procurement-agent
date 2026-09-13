import { z } from 'zod';

export function normalizeContractorPhone(value: string) {
  const digits = value.replace(/\D/g, '');
  if (value.startsWith('+')) return `+${digits}`;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

const phone = z.string().trim().max(40)
  .regex(/^\+?[\d\s().-]+$/, 'Enter a valid phone number.')
  .refine((value) => value.startsWith('+') || /^(\d{10}|1\d{10})$/.test(value.replace(/\D/g, '')),
    'Include the country code for numbers outside the US and Canada.')
  .transform(normalizeContractorPhone)
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number.'));

const optionalWebsite = z.string().trim().max(2048).transform((value) => {
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}).pipe(z.url({ protocol: /^https?$/, hostname: z.regexes.domain }).refine((value) => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !/\s/.test(value);
  } catch { return false; }
}, 'Enter a website like yourcompany.com.').optional());

export const contractorSignupSchema = z.object({
  submissionId: z.uuid(),
  firstName: z.string().trim().min(1, 'Enter your first name.').max(100),
  lastName: z.string().trim().min(1, 'Enter your last name.').max(100),
  phone,
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  website: optionalWebsite.optional(),
  licenseNumber: z.string().trim().max(100).transform((value) => value || undefined).optional(),
}).strict();
