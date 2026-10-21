import type { ResolvedModel } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { StoredModelFile } from '@/logic/model-file-system';

/** An already accepted snapshot for transport tests, without a storage lookup. */
export function resolvedModelFixture({ modelId }: { modelId: string }): ResolvedModel {
  const file = new File([new Uint8Array(24)], 'model.gguf', { lastModified: 1 });
  const entry: StoredModelFile = {
    relativePath: 'model.gguf',
    file,
    storageKind: 'opfs',
    handle: { kind: 'file', name: 'model.gguf', getFile: async () => file, isSameEntry: async () => true } as unknown as FileSystemFileHandle,
  };
  return { modelId, location: { kind: 'opfs-user', rootName: modelId.startsWith('user/') ? modelId.slice(5) : modelId }, directory: { files: [entry], primaryFile: entry, projectorFile: undefined } };
}

export const TEST_ONLY = {
};
