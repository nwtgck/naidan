export { default as FileExplorer } from './components/FileExplorer.vue';
export { useFileExplorer, FILE_EXPLORER_INJECTION_KEY } from './composables/useFileExplorer';
export type { FileExplorerContext, FileExplorerEntry, ViewMode, PreviewVisibility } from './logic/types';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
