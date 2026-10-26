/** Copy context only. Never use this value to choose requests or feature behavior. */
export type CspHintActivityForDisplayOnly =
  | 'connection'
  | 'model-list'
  | 'response-generation'
  | 'image-generation'
  | 'title-generation'
  | 'context-summary'
  | 'prompt-translation'
  | 'model-search'
  | 'model-information'
  | 'quantization-options'
  | 'download'
  | 'running-models'
  | 'unload-model'
  | 'wikipedia'
  | 'relay';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
