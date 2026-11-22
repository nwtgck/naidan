export const GGUF_EDITABLE_METADATA_KEYS = ['tokenizer.chat_template', 'general.name', 'general.description', 'general.author'] as const;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
