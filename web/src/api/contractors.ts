import { useMutation } from '@tanstack/react-query';
import type { ContractorSignupData } from '../schema/contractor.js';

export interface DesignAgentContact {
  name: string;
  phone: string;
  email: string | null;
  website: string | null;
}

export function useContractorSignup() {
  return useMutation({
    mutationFn: async (data: ContractorSignupData & { submissionId: string }) => {
      const response = await fetch('/api/contractors/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      }).catch(() => { throw new Error('We couldn’t connect. Check your internet connection and try again.'); });
      if (!response.ok) {
        const messages: Record<number, string> = {
          400: 'Please check your details and try again.',
          409: 'We couldn’t submit these details. Refresh this page and try again.',
          413: 'Some details are too long. Shorten them and try again.',
          429: 'Too many signup attempts. Please wait up to 15 minutes and try again.',
          503: 'Signup is temporarily unavailable. Please try again later.',
        };
        throw new Error(messages[response.status] || 'We couldn’t finish signup. Please try again.');
      }
      const result = await response.json().catch(() => { throw new Error('We couldn’t finish signup. Please try again.'); });
      if (!result?.success || !/^\+[1-9]\d{7,14}$/.test(result.agent?.phone)) {
        throw new Error('We couldn’t load FORM’s number. Please try again.');
      }
      return result as { success: true; agent: DesignAgentContact };
    },
  });
}
