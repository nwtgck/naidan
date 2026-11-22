import { createEditorSearchWorker } from './impl';
import {
  editorReplaceResponseSchema,
  editorSearchResponseSchema,
  type EditorSearchClient,
  type EditorSearchWorker,
} from './types';

export function wrapEditorSearchClient({ api, dispose }: { api: EditorSearchWorker, dispose: () => Promise<void> }): EditorSearchClient {
  return {
    setDocument: ({ snapshot }) => api.setDocument({ snapshot }),
    applyChanges: ({ changes }) => api.applyChanges({ changes }),
    async search({ request }) {
      return editorSearchResponseSchema.parse(await api.search({ request }));
    },
    async replace({ request }) {
      return editorReplaceResponseSchema.parse(await api.replace({ request }));
    },
    dispose,
  };
}

export function createEditorSearchFallback(): EditorSearchClient {
  return wrapEditorSearchClient({ api: createEditorSearchWorker({ runtime: 'fallback' }), dispose: async () => {} });
}

export const TEST_ONLY = {
};
