import type { Component } from 'vue';

export const isDownloadVerificationAvailable = true;

export async function loadDownloadVerificationModal(): Promise<Component> {
  const module = await import('./components/DownloadVerificationModal.vue');
  return module.default;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
