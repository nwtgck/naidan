import type { EndpointType } from '@/01-models/types';

/** Distribution policy, not a hardware probe. Keep unavailable choices visible.
 * Onboarding may still open their explanation; only use/start actions are blocked. */
export function getEndpointBuildAvailability({ type }: { type: EndpointType }): 'available' | 'unavailable-in-standalone' {
  switch (type) {
  case 'transformers_js': return __BUILD_MODE_IS_STANDALONE__ ? 'unavailable-in-standalone' : 'available';
  case 'openai': case 'ollama': case 'llama_cpp_browser': case 'browser_provided_lm': return 'available';
  default: { const exhaustive: never = type; throw new Error(`Unhandled endpoint type: ${exhaustive}`); }
  }
}
export const TEST_ONLY = {
};
