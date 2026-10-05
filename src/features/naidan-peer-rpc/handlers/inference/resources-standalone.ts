import type { OwnedInferenceResources } from './resources';
import type { HostModelDirectoryId } from '@/01-models/ids';

/** Caller-only does not imply native inference availability. This facade
 * intentionally imports no native engine, model scanner, Worker or Wasm. */
export function createReadOnlyResources({ directories }: { directories(): readonly { id: HostModelDirectoryId, name: string }[] }): OwnedInferenceResources {
  void directories;
  const unavailable = async (): Promise<never> => {
    throw new Error('Local inference provision is not included in this build');
  };
  return { listChatModels: unavailable, listImageModels: unavailable, generateChat: unavailable, generateImage: unavailable, dispose() {} };
}
export const TEST_ONLY = {
};
