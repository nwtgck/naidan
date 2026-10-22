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
  stop(): void,
};

const sessions = shallowRef(new Map<ChatId, LocalModelLaunchSession>());
const observations = new WeakMap<LocalModelLaunchSession, { owners: Set<object> }>();

/** Concurrent views share one session; a return after all views leave rechecks it. */
export function attachLocalModelLaunchView({ session }: { session: LocalModelLaunchSession }): { recheck: 'required' | 'retained', release(): void } {
  const observation = observations.get(session);
  if (observation === undefined) {
    throw new Error('Unknown local model session');
  }
  const owner = {};
  const recheck = observation.owners.size === 0 ? 'required' : 'retained';
  observation.owners.add(owner);
  return {
    recheck,
    release() {
      observation.owners.delete(owner);
    },
  };
}

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
    && binding.modelId !== undefined && binding.modelId === session.model.modelId;
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

/** Explicit local-model actions own a preparation view while the chat is empty. */
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
    stop: () => {},
  });
  if (!bindingMatches({ session, binding: readBinding() })) {
    return;
  }
  observations.set(session, { owners: new Set() });
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

export const TEST_ONLY = {
};
