import { z } from 'zod';
import type { InferenceMessage } from './types';

const ReasoningSchema = z.object({
  text: z.string(),
  completeness: z.enum(['complete', 'partial']),
});

/** Validate before a model template can close a stored reasoning segment. */
export function readCompleteInferenceReasoning({ message }: { message: InferenceMessage }): string | undefined {
  if (message.reasoning === undefined) return undefined;
  if (message.role !== 'assistant') throw new Error('Only assistant messages can contain structured reasoning.');
  const { text, completeness } = ReasoningSchema.parse(message.reasoning);
  switch (completeness) {
  case 'complete': return text;
  case 'partial': throw new Error('The model template cannot close unfinished structured reasoning.');
  default: { const exhaustive: never = completeness; throw new Error(`Unhandled reasoning completeness: ${exhaustive}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
