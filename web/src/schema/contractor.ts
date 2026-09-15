import * as v from 'valibot';

const name = (label: string) => v.pipe(v.string(), v.trim(), v.minLength(1, `Enter your ${label}.`), v.maxLength(100));

export const contractorSignupSchema = v.object({
  firstName: name('first name'),
  lastName: name('last name'),
  businessName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(150, 'Use 150 characters or fewer.'))),
  phone: v.pipe(v.string(), v.trim(), v.maxLength(40), v.check((value) => {
    if (!/^\+?[\d\s().-]+$/.test(value)) return false;
    const digits = value.replace(/\D/g, '');
    return value.startsWith('+') ? /^[1-9]\d{7,14}$/.test(digits) : /^(\d{10}|1\d{10})$/.test(digits);
  }, 'Enter a valid phone number, including country code outside the US or Canada.')),
  email: v.pipe(v.string(), v.trim(), v.email('Enter a valid email address.'), v.maxLength(254)),
  website: v.pipe(v.string(), v.trim(), v.maxLength(2048), v.check((value) => {
    if (!value) return true;
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      return /^https?:$/.test(url.protocol) && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)
        && !url.username && !url.password && !/\s/.test(value);
    } catch { return false; }
  }, 'Enter a website like yourcompany.com.')),
  licenseNumber: v.pipe(v.string(), v.trim(), v.maxLength(100, 'Use 100 characters or fewer.')),
});

export type ContractorSignupData = v.InferOutput<typeof contractorSignupSchema>;
