import * as Comlink from 'comlink';

import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
import {
  advancedTextEditorV3ApplyMultiEditResponseSchema,
  advancedTextEditorV3PrepareMultiEditResponseSchema,
  advancedTextEditorV3ReplaceAllResponseSchema,
  advancedTextEditorV3ReplaceSingleResponseSchema,
  advancedTextEditorV3SearchTextResponseSchema,
  type AdvancedTextEditorV3WorkerClient,
} from './types';

export async function createAdvancedTextEditorV3WorkerClient(): Promise<AdvancedTextEditorV3WorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remote = Comlink.wrap<IWorkerHub>(worker);
  const advancedTextEditorV3 = await remote.advancedTextEditorV3;

  return {
    async searchText({ request }) {
      return advancedTextEditorV3SearchTextResponseSchema.parse(await advancedTextEditorV3.searchText({ request }));
    },
    async replaceAll({ request }) {
      return advancedTextEditorV3ReplaceAllResponseSchema.parse(await advancedTextEditorV3.replaceAll({ request }));
    },
    async replaceSingle({ request }) {
      return advancedTextEditorV3ReplaceSingleResponseSchema.parse(await advancedTextEditorV3.replaceSingle({ request }));
    },
    async prepareMultiEdit({ request }) {
      return advancedTextEditorV3PrepareMultiEditResponseSchema.parse(await advancedTextEditorV3.prepareMultiEdit({ request }));
    },
    async applyMultiEdit({ request }) {
      return advancedTextEditorV3ApplyMultiEditResponseSchema.parse(await advancedTextEditorV3.applyMultiEdit({ request }));
    },
    async dispose() {
      try {
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}
