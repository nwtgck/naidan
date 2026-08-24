import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/advanced-text-editor-v3';
import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
  STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
} from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import {
  advancedTextEditorV3ApplyMultiEditResponseSchema,
  advancedTextEditorV3PrepareMultiEditResponseSchema,
  advancedTextEditorV3ReplaceAllResponseSchema,
  advancedTextEditorV3ReplaceSingleResponseSchema,
  advancedTextEditorV3SearchTextResponseSchema,
  type IAdvancedTextEditorV3Worker,
  type AdvancedTextEditorV3WorkerClient,
} from './types';

export async function createAdvancedTextEditorV3WorkerClient(): Promise<AdvancedTextEditorV3WorkerClient> {
  const session = await createStandaloneWorkerSession<IAdvancedTextEditorV3Worker>({ createWorker: createStandaloneWorker });
  const { remote } = session;

  return {
    async searchText({ request }) {
      return advancedTextEditorV3SearchTextResponseSchema.parse(await remote.searchText({ request }));
    },
    async replaceAll({ request }) {
      return advancedTextEditorV3ReplaceAllResponseSchema.parse(await remote.replaceAll({ request }));
    },
    async replaceSingle({ request }) {
      return advancedTextEditorV3ReplaceSingleResponseSchema.parse(await remote.replaceSingle({ request }));
    },
    async prepareMultiEdit({ request }) {
      return advancedTextEditorV3PrepareMultiEditResponseSchema.parse(await remote.prepareMultiEdit({ request }));
    },
    async applyMultiEdit({ request }) {
      return advancedTextEditorV3ApplyMultiEditResponseSchema.parse(await remote.applyMultiEdit({ request }));
    },
    async dispose() {
      await disposeStandaloneWorkerSession({
        session,
        beforeRelease: undefined,
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
