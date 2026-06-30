// Compatibility entrypoint used only by .test.ts files that still exercise the legacy useChat API.
// Production code should not add new useChat dependencies; new features should use an existing
// focused composable or introduce a new focused composable instead.
export { useChat } from '@/composables/chat/compat/useChatFacade';
export type { AddToastOptions } from '@/composables/chat/compat/useChatFacade';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
