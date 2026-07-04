import { createModuleLoader } from '@/utils/module-loader';

const chatWorkerMountsModuleLoader = createModuleLoader({
  importModule: () => import('@/features/wesh/chat-worker-mounts'),
  onPrefetchError: ({ error }) => {
    console.error('Failed to prefetch Wesh chat mounts:', error);
  },
});

export async function loadChatWorkerMountsModule() {
  return await chatWorkerMountsModuleLoader.load();
}

export async function prefetchChatWorkerMountsModule(): Promise<void> {
  await chatWorkerMountsModuleLoader.prefetch();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
