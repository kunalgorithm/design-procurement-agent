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
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'We couldn’t connect. Please try again.');
      if (!result?.success || !/^\+[1-9]\d{7,14}$/.test(result.agent?.phone)) {
        throw new Error('We couldn’t connect you with your agent. Please try again.');
      }
      return result as { success: true; agent: DesignAgentContact };
    },
  });
}
