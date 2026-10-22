import { reactive, shallowReactive, shallowRef, watch } from 'vue';
import type { ChatId } from '@/01-models/ids';
import type { Chat, Endpoint } from '@/01-models/types';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { LlamaCppBrowserError, type ErrorCode, type LocalModel, type Progress } from '@/features/llama-cpp-browser/types';

type LocalModelLaunchBinding = { chatGroupId: Chat['groupId'], endpoint: Endpoint, modelId: string | undefined };
export type LocalModelLaunchSession = {
  chatId: ChatId,
  chatGroupId: Chat['groupId'],
  model: LocalModel,
  homeOriginId: string | undefined,
  status: 'loading' | 'ready' | 'error',
  progress: Progress | undefined,
  error: ErrorCode | undefined,
  controller: AbortController | undefined,
  isCurrent(): boolean,
  readBinding(): LocalModelLaunchBinding,
  acceptedModelIds: ReadonlySet<string>,
  stop(): void,
};

const sessions = shallowRef(new Map<ChatId, LocalModelLaunchSession>());

export function localModelLaunchSession({ chatId }: { chatId: ChatId }): LocalModelLaunchSession | undefined {
  return sessions.value.get(chatId);
}

/** This synchronous admission check never starts a load or metadata request. */
export function assertLocalModelLaunchReady({ chat, endpoint, modelId }: {
  chat: Pick<Chat, 'id' | 'root'>,
  endpoint: Endpoint,
  modelId: string | undefined,
}): { assertCurrent(): void } | undefined {
  const session = sessions.value.get(chat.id);
  if (session === undefined || chat.root.items.length > 0) {
    return;
  }
  const selectedModelId = session.model.modelId;
  const assertCurrent = () => {
    if (sessions.value.get(chat.id) !== session || !session.isCurrent()
      || !bindingMatches({ session, binding: session.readBinding() })
      || endpoint.type !== 'llama_cpp_browser' || modelId !== selectedModelId || session.model.modelId !== selectedModelId) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    switch (session.status) {
    case 'ready': return;
    case 'loading':
    case 'error':
      throw new LlamaCppBrowserError({ code: 'busy' });
    default: {
      const exhaustive: never = session.status;
      throw new Error(String(exhaustive));
    }
    }
  };
  assertCurrent();
  return { assertCurrent };
}

export function updateLocalModelLaunchSession({ session }: { session: LocalModelLaunchSession }): void {
  if (sessions.value.get(session.chatId) === session) {
    sessions.value = new Map(sessions.value);
  }
}

function bindingMatches({ session, binding }: { session: LocalModelLaunchSession, binding: LocalModelLaunchBinding }): boolean {
  return binding.chatGroupId === session.chatGroupId && binding.endpoint.type === 'llama_cpp_browser'
    && binding.modelId !== undefined && session.acceptedModelIds.has(binding.modelId);
}

export function retireLocalModelLaunchSession({ session }: { session: LocalModelLaunchSession }): void {
  if (sessions.value.get(session.chatId) !== session) {
    return;
  }
  const remaining = new Map(sessions.value);
  remaining.delete(session.chatId);
  sessions.value = remaining;
  session.controller?.abort();
  session.stop();
}

/** Only the empty chat created by this explicit local-model action owns a view. */
export function registerLocalModelLaunchSession({ chat, model, homeOriginId, isCurrent, readBinding }: {
  chat: Chat,
  model: LocalModel,
  homeOriginId: string | undefined,
  isCurrent(): boolean,
  readBinding(): LocalModelLaunchBinding,
}): void {
  const prior = sessions.value.get(chat.id);
  if (prior !== undefined && prior.model.modelId === model.modelId && prior.isCurrent()) {
    return;
  }
  if (prior !== undefined) {
    retireLocalModelLaunchSession({ session: prior });
  }
  if (chat.root.items.length > 0 || !isCurrent()) {
    return;
  }
  const live = reactive(chat);
  const session = shallowReactive<LocalModelLaunchSession>({
    chatId: chat.id,
    chatGroupId: chat.groupId,
    model,
    homeOriginId,
    status: 'loading',
    progress: undefined,
    error: undefined,
    controller: undefined,
    isCurrent,
    readBinding,
    acceptedModelIds: new Set([model.modelId]),
    stop: () => {},
  });
  if (!bindingMatches({ session, binding: readBinding() })) {
    return;
  }
  sessions.value = new Map(sessions.value).set(chat.id, session);
  const validate = () => {
    if (live.root.items.length > 0 || !session.isCurrent() || !bindingMatches({ session, binding: readBinding() })) {
      retireLocalModelLaunchSession({ session });
    }
  };
  const stopWatch = watch(() => ({ binding: readBinding(), messages: live.root.items.length }), validate, { flush: 'sync' });
  const unsubscribe = llamaCppBrowserModelFiles.subscribeModelList({ listener: validate });
  session.stop = () => {
    stopWatch();
    unsubscribe();
  };
}

/** A narrow promotion window accepts only the captured source and saved IDs. */
export function beginLocalModelLaunchPromotion({ chatId, sourceModelId, model, isCurrent }: {
  chatId: ChatId,
  sourceModelId: string,
  model: LocalModel,
  isCurrent(): boolean,
}): { finish(): void } | undefined {
  const session = sessions.value.get(chatId);
  if (session === undefined || session.model.modelId !== sourceModelId || !session.isCurrent() || !isCurrent()) {
    return undefined;
  }
  session.acceptedModelIds = new Set([sourceModelId, model.modelId]);
  return {
    finish() {
      if (sessions.value.get(chatId) !== session) {
        return;
      }
      const binding = session.readBinding();
      if (!bindingMatches({ session, binding })) {
        retireLocalModelLaunchSession({ session });
      } else if (binding.modelId === model.modelId && !isCurrent()) {
        retireLocalModelLaunchSession({ session });
      } else if (binding.modelId === model.modelId) {
        session.controller?.abort();
        session.controller = undefined;
        session.model = model;
        session.isCurrent = isCurrent;
        session.acceptedModelIds = new Set([model.modelId]);
        session.status = 'loading';
        session.progress = undefined;
        session.error = undefined;
        updateLocalModelLaunchSession({ session });
      } else {
        session.acceptedModelIds = new Set([sourceModelId]);
        if (!session.isCurrent()) {
          retireLocalModelLaunchSession({ session });
        }
      }
    },
  };
}

export const TEST_ONLY = {
};
