// Test-only compatibility entrypoint for the existing chat behavior tests.
// Those tests must be retained; this is not a temporary migration shim.
// Never use this entrypoint in production. New features belong in an existing
// focused composable or a new focused composable.
export { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from '@/composables/chat/compat/useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProductionFacade';
export type { AddToastOptions } from '@/composables/chat/compat/useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProductionFacade';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
