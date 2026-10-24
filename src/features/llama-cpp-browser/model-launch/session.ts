import type { ChatId } from '@/01-models/ids';
import type { DownloadDestination } from '@/01-models/download';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { ModelLaunchDefaultSnapshot } from './defaults';

export type ModelLaunchSession = {
  chatId: ChatId,
  homeOriginId: string | undefined,
  requestKey: string,
  target: ModelLaunchTarget,
  destination: DownloadDestination,
  effectiveModelId: string,
  expectedRoot: FileSystemDirectoryHandle | undefined,
  isStorageCurrent(): boolean,
  defaults: Promise<ModelLaunchDefaultSnapshot | undefined>,
  defaultAttempted: boolean,
  consumed: boolean,
};

const sessions = new Map<ChatId, ModelLaunchSession>();

export function rememberModelLaunchSession({ session }: { session: ModelLaunchSession }): void {
  sessions.set(session.chatId, session);
}

export function readModelLaunchSession({ chatId }: { chatId: ChatId }): ModelLaunchSession | undefined {
  const session = sessions.get(chatId);
  return session?.isStorageCurrent() ? session : undefined;
}

export function findModelLaunchSession({ homeOriginId, requestKey }: { homeOriginId: string, requestKey: string }): ModelLaunchSession | undefined {
  return [...sessions.values()].find(session => session.homeOriginId === homeOriginId && session.requestKey === requestKey && session.isStorageCurrent() && !session.consumed);
}

export function consumeModelLaunchSession({ chatId }: { chatId: ChatId }): void {
  const session = sessions.get(chatId);
  if (session !== undefined) {
    session.consumed = true;
  }
}

export const TEST_ONLY = {
  reset: () => sessions.clear(),
};
