
import { highlightCodeInWorker } from './core';
import {
  highlightRequestSchema,
  highlightResponseSchema,
  type IHighlightWorker,
} from './types';

export function createHighlightWorker(): IHighlightWorker {
  return {
    async highlight({ request }) {
      const validated = highlightRequestSchema.parse(request);
      return highlightResponseSchema.parse(highlightCodeInWorker({
        code: validated.code,
        language: validated.language,
        mode: validated.mode,
      }));
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
