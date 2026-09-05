import type { Component } from 'vue';

export const isDownloadVerificationAvailable = false;

export async function loadDownloadVerificationModal(): Promise<Component> {
  throw new Error('Transformers.js Download Verification is unavailable in Standalone builds');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
