import type { Component } from 'vue';

export const isModelSupportInvestigationAvailable = false;

export async function loadModelSupportInvestigationModal(): Promise<Component> {
  throw new Error('Model Support Investigation is unavailable in Standalone builds');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
