import { normalizeHuggingFaceParameterFilter } from '@/features/privacy-fetch/policies/huggingface';

export function createSearchParameterFilter({ minimumBillions, maximumBillions }: { minimumBillions: string, maximumBillions: string }): string | undefined {
  if ([minimumBillions, maximumBillions].some(value => value.trim() && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) {
    throw new Error('Invalid parameter range');
  }
  const minimum = minimumBillions.trim().replace(/^\./, '0.').replace(/\.$/, '');
  const maximum = maximumBillions.trim().replace(/^\./, '0.').replace(/\.$/, '');
  if (!minimum && !maximum) {
    return undefined;
  }
  const raw = [minimum ? `min:${minimum}B` : undefined, maximum ? `max:${maximum}B` : undefined].filter(bound => bound !== undefined).join(',');
  const normalized = normalizeHuggingFaceParameterFilter({ value: raw });
  if (normalized === undefined) {
    throw new Error('Invalid parameter range');
  }
  return normalized;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
