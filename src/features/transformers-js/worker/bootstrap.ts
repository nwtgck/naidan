import { createDownloadedModelWorkerFetch } from '@/features/transformers-js/runtime/offline-worker-fetch';
import { startProductionWorkerRuntime } from './production-worker-startup';

// This bootstrap intentionally does not import Transformers.js. Install the
// fixed offline network capability first, then evaluate the runtime entry so
// Transformers.js can never observe or retain the unrestricted browser fetch.
const originalFetch = self.fetch;
self.fetch = createDownloadedModelWorkerFetch({
  originalFetch,
  workerLocationUrl: self.location.href,
  environment: import.meta.env.DEV ? 'development' : 'production',
  userAgent: navigator.userAgent,
  vendor: navigator.vendor,
});

void startProductionWorkerRuntime({
  loadEntry: () => import('./entry'),
  postMessage: ({ message }) => self.postMessage(message),
}).catch(error => {
  // Surface entry evaluation failures as Worker errors instead of leaving an
  // unhandled rejection that callers can only observe as a hung RPC.
  setTimeout(() => {
    throw error;
  });
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
