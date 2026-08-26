import type { Component } from 'vue';

export const isModelSupportInvestigationAvailable = true;

export async function loadModelSupportInvestigationModal(): Promise<Component> {
  const module = await import('./components/ModelSupportInvestigationModal.vue');
  return module.default;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
