import { computed, onScopeDispose, watch, type ComputedRef } from 'vue';
import type { Chat, Endpoint } from '@/01-models/types';
import { useAppEntry } from '@/composables/useAppEntry';
import { errorCode, type ErrorCode, type Progress } from '@/features/llama-cpp-browser/types';
import { attachLocalModelLaunchView, localModelLaunchSession, retireLocalModelLaunchSession, updateLocalModelLaunchSession, type LocalModelLaunchSession } from './local-model-launch-session';
import { hasChatLocalModelPreparation } from '@/composables/chat/chat-scoped/chat-model-binding-operations';

const preparations = new WeakMap<LocalModelLaunchSession, Promise<void>>();

/** A replacement action waits for this chat's cancelled advisory warmup only. */
export async function suspendLocalModelLaunchPreparation({ chatId }: { chatId: Chat['id'] }): Promise<void> {
  const session = localModelLaunchSession({ chatId });
  if (session === undefined) {
    return;
  }
  // Retire first so returning views cannot restart this cancelled warmup.
  retireLocalModelLaunchSession({ session });
  session.controller?.abort();
  session.controller = undefined;
  await preparations.get(session);
}

async function runSessionPreparation({ session }: { session: LocalModelLaunchSession }): Promise<void> {
  if (session.controller !== undefined || !session.isCurrent()) {
    return;
  }
  const controller = new AbortController();
  session.controller = controller;
  session.status = 'loading';
  session.progress = undefined;
  session.error = undefined;
  updateLocalModelLaunchSession({ session });
  const current = () => !controller.signal.aborted && session.controller === controller && session.isCurrent() && localModelLaunchSession({ chatId: session.chatId }) === session;
  try {
    const { llamaCppBrowserService } = await import('@/features/llama-cpp-browser');
    if (!current()) {
      return;
    }
    const outcome = await llamaCppBrowserService.prepareModel({
      modelId: session.model.modelId,
      signal: controller.signal,
      onProgress: ({ progress }: { progress: Progress }) => {
        if (!current()) {
          return;
        }
        session.progress = progress;
        updateLocalModelLaunchSession({ session });
      },
    });
    if (!current()) {
      return;
    }
    switch (outcome) {
    case 'ready': session.status = 'ready';
      break;
    case 'skipped-busy':
      session.status = 'error';
      session.error = 'busy';
      break;
    default: {
      const exhaustive: never = outcome;
      throw new Error(String(exhaustive));
    }
    }
    updateLocalModelLaunchSession({ session });
  } catch (error) {
    if (!current()) {
      return;
    }
    session.status = 'error';
    session.error = errorCode({ error });
    updateLocalModelLaunchSession({ session });
  }
}

function prepareSession({ session }: { session: LocalModelLaunchSession }): Promise<void> {
  const pending = runSessionPreparation({ session });
  preparations.set(session, pending);
  void pending.finally(() => {
    if (preparations.get(session) === pending) {
      preparations.delete(session);
    }
  }).catch(() => {});
  return pending;
}

export function useLocalModelLaunchChat({ chat, resolved }: {
  chat: ComputedRef<Chat | null>,
  resolved: ComputedRef<{ endpoint: Endpoint, modelId: string | undefined } | undefined>,
}) {
  const entry = useAppEntry();
  const session = computed(() => chat.value === null ? undefined : localModelLaunchSession({ chatId: chat.value.id }));
  const visible = computed(() => {
    const current = chat.value;
    const selected = session.value;
    const binding = resolved.value;
    return current !== null && current.root.items.length === 0 && selected !== undefined && selected.isCurrent()
      && current.groupId === selected.chatGroupId && binding?.endpoint.type === 'llama_cpp_browser'
      && binding.modelId !== undefined && binding.modelId === selected.model.modelId;
  });
  let observedSession: LocalModelLaunchSession | undefined;
  let recheckPending = false;
  let view: ReturnType<typeof attachLocalModelLaunchView> | undefined;
  onScopeDispose(() => view?.release());
  watch([chat, resolved, session, () => session.value?.model.modelId, () => session.value?.status, () => session.value?.controller, () => chat.value !== null && hasChatLocalModelPreparation({ chatId: chat.value.id })], () => {
    const selected = session.value;
    if (selected === undefined) {
      view?.release();
      view = undefined;
      observedSession = undefined;
      recheckPending = false;
      return;
    }
    if (selected !== observedSession) {
      view?.release();
      view = attachLocalModelLaunchView({ session: selected });
      recheckPending = view.recheck === 'required';
    }
    observedSession = selected;
    // An in-flight preparation completing after this view returned already
    // supplies the required engine check; do not immediately warm it again.
    if (selected.status === 'loading' && selected.controller !== undefined) {
      recheckPending = false;
    }
    if (!visible.value) {
      retireLocalModelLaunchSession({ session: selected });
    } else if (hasChatLocalModelPreparation({ chatId: selected.chatId })) {
      return;
    } else if (selected.status === 'ready' && recheckPending) {
      recheckPending = false;
      selected.controller = undefined;
      void prepareSession({ session: selected });
    } else if (selected.status === 'loading' && selected.controller === undefined) {
      recheckPending = false;
      void prepareSession({ session: selected });
    }
  }, { immediate: true, flush: 'post' });

  async function retry(): Promise<void> {
    const selected = session.value;
    if (!visible.value || selected === undefined || selected.status !== 'error') {
      return;
    }
    selected.controller = undefined;
    await prepareSession({ session: selected });
  }

  async function back(): Promise<void> {
    const origin = session.value?.homeOriginId;
    if (visible.value && origin !== undefined) {
      await entry.returnToHome({ homeOriginId: origin });
    }
  }

  return {
    visible,
    model: computed(() => visible.value ? session.value?.model : undefined),
    homeOriginId: computed(() => session.value?.homeOriginId),
    status: computed<'loading' | 'ready' | 'error'>(() => session.value?.status ?? 'loading'),
    progress: computed<Progress | undefined>(() => session.value?.progress),
    error: computed<ErrorCode | undefined>(() => session.value?.error),
    maySend: computed(() => !visible.value || session.value?.status === 'ready'),
    retry,
    back,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export type LocalModelLaunchChatUi = ReturnType<typeof useLocalModelLaunchChat>;
export const TEST_ONLY = {
};
