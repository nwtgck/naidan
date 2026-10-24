import type { ChatId } from '@/01-models/ids';
import type { DownloadDestination } from '@/01-models/download';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';

type PreparationReader = ({ target, destination, effectiveModelId }: { target: ModelLaunchTarget, destination: DownloadDestination, effectiveModelId: string }) => boolean;
const readers = new Map<ChatId, Set<PreparationReader>>();

/** Actual preparation owners publish a synchronous read; querying never starts work. */
export function registerModelLaunchPreparation({ chatId, isReady }: { chatId: ChatId, isReady: PreparationReader }): () => void {
  const owners = readers.get(chatId) ?? new Set<PreparationReader>();
  owners.add(isReady);
  readers.set(chatId, owners);
  return () => {
    owners.delete(isReady);
    if (owners.size === 0 && readers.get(chatId) === owners) {
      readers.delete(chatId);
    }
  };
}

export function isModelLaunchPrepared({ chatId, target, destination, effectiveModelId }: { chatId: ChatId, target: ModelLaunchTarget, destination: DownloadDestination, effectiveModelId: string }): boolean {
  return [...(readers.get(chatId) ?? [])].some(isReady => isReady({ target, destination, effectiveModelId }));
}

export const TEST_ONLY = {
  reset: () => readers.clear(),
};
