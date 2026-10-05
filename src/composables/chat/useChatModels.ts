import { computed, ref, watch, getCurrentScope, onScopeDispose, type ComputedRef, type Ref } from 'vue';
import { useChatViewScope } from './ui/chat-view-scope';
import type { Endpoint } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';
import {
  availableModels,
  fetchingModels,
} from '@/composables/chat/global/chat-core-singletons';
import {
  fetchModelsForChat,
  fetchModelsForEndpoint,
  fetchModelsForGlobalEndpoint,
} from '@/composables/chat/chat-model-fetch';

export type ChatModelsAdapter = {
  availableModels: Ref<string[]>,
  fetchingModels: ComputedRef<boolean>,

  fetchForChat({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<string[]>,

  fetchForGlobalEndpoint(): Promise<string[]>,

  fetchForEndpoint({
    endpoint,
  }: {
    endpoint: Endpoint,
  }): Promise<string[]>,

  TEST_ONLY: Record<never, never>,
};

export function useChatModels({ scope: providedScope }: { scope?: Readonly<Ref<ChatId>> } = {}): ChatModelsAdapter {
  const scope = providedScope ?? useChatViewScope();
  const modelsForView = scope ? ref<string[]>([]) : availableModels;
  const requests = ref(0);
  const fetchingModelsState = computed(() => scope ? requests.value > 0 : fetchingModels.value);
  let sequence = 0, disposed = false;
  // An embedded ChatPane must not borrow the globally selected chat's model
  // list. Each view also rejects late responses after switching its identity.
  if (scope) watch(scope, () => {
    sequence++; modelsForView.value = [];
  }, { flush: 'sync' });
  if (getCurrentScope()) onScopeDispose(() => {
    disposed = true; sequence++;
  });

  async function fetchForChat({
    chatId,
  }: {
    chatId: ChatId,
  }): Promise<string[]> {
    const token = ++sequence;
    requests.value++;
    try {
      const result = await fetchModelsForChat({ chatId, errorSource: 'useChatModels:fetchForChat' });
      if (scope && scope.value === chatId && token === sequence && !disposed) modelsForView.value = result;
      return result;
    } finally {
      requests.value--;
    }
  }

  async function fetchForGlobalEndpoint(): Promise<string[]> {
    return await fetchModelsForGlobalEndpoint({
      errorSource: 'useChatModels:fetchForGlobalEndpoint',
    });
  }

  async function fetchForEndpoint({
    endpoint,
  }: {
    endpoint: Endpoint,
  }): Promise<string[]> {
    requests.value++;
    try {
      return await fetchModelsForEndpoint({ endpoint, errorSource: 'useChatModels:fetchForEndpoint' });
    } finally {
      requests.value--;
    }
  }

  return {
    availableModels: modelsForView,
    fetchingModels: fetchingModelsState,
    fetchForChat,
    fetchForGlobalEndpoint,
    fetchForEndpoint,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
