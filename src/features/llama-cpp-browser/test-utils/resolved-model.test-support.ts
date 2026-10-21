import type { ModelRootLocation, ResolvedModel } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { ModelFile } from '@/logic/model-file-system';

/** A captured, valid GGUF file with the same provenance as its logical root. */
export function createResolvedModelForTest({ modelId, relativePath }: { modelId: string, relativePath: string }): ResolvedModel {
  const bytes = new Uint8Array(24);
  bytes.set([71, 71, 85, 70]);
  new DataView(bytes.buffer).setUint32(4, 3, true);
  const file = new File([bytes], relativePath.split('/').at(-1)!, { lastModified: 1 });
  let location: ModelRootLocation;
  let primaryFile: ModelFile;
  if (modelId.startsWith('temp/')) {
    location = { kind: 'temp', rootPath: modelId.split('/').slice(0, 2).join('/').split(':')[0]! };
    primaryFile = { relativePath, file, storageKind: 'temp', registrationRevision: 1 };
  } else {
    const handle = { kind: 'file', name: file.name, getFile: async () => file } as FileSystemFileHandle;
    if (modelId.startsWith('host/')) {
      location = { kind: 'host', directoryId: 'root', repository: modelId.split('/').slice(2).join('/').split(':')[0]! };
      primaryFile = { relativePath, file, handle, storageKind: 'host' };
    } else if (modelId.startsWith('hf.co/')) {
      location = { kind: 'hugging-face', repository: modelId.slice('hf.co/'.length).split(':')[0]! };
      primaryFile = { relativePath, file, handle, storageKind: 'opfs' };
    } else {
      location = { kind: 'opfs-user', rootName: modelId.slice('user/'.length) };
      primaryFile = { relativePath, file, handle, storageKind: 'opfs' };
    }
  }
  return { modelId, location, directory: { files: [primaryFile], primaryFile, projectorFile: undefined } };
}

export const TEST_ONLY = {
};
