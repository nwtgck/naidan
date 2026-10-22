<script setup lang="ts">
import { watch, computed, shallowRef, onScopeDispose } from 'vue';
import { storageService } from '@/00-storage/service';
import { hasModelEntryQuery } from '@/logic/startup/entry-intent';
import { useRouter } from 'vue-router';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import CurrentChatPane from '@/components/CurrentChatPane.vue';
import { toChatId, toMessageId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';

const router = useRouter();
const currentRoute = computed(() => router?.currentRoute?.value);
const chatNavigation = useChatNavigation();

const chatId = computed(() => {
  const params = currentRoute.value?.params;
  // Use a type guard or check property existence to satisfy TS
  if (params && 'id' in params) {
    return params.id as string;
  }
  return undefined;
});

const leafId = computed(() => currentRoute.value?.query?.leaf?.toString());
const messageId = computed(() => {
  const raw = currentRoute.value?.query?.['message-id']?.toString();
  return raw === undefined ? undefined : toMessageId({ raw });
});

const target = computed(() => ({ id: chatId.value, leafId: leafId.value, messageId: messageId.value }));
const load = shallowRef<{
  target: typeof target.value,
  status: 'loading' | 'ready' | 'error',
  route: typeof currentRoute.value,
}>();
const loadStatus = computed(() => load.value?.target === target.value && load.value?.route === currentRoute.value ? load.value.status : 'loading');
let active = true;

async function syncChat() {
  const route = currentRoute.value;
  if (!active || route === undefined || hasModelEntryQuery({ query: route.query })) {
    return;
  }
  const request = { target: target.value, route, status: 'loading' as const };
  load.value = request;
  const { id, leafId, messageId } = request.target;
  if (!id) {
    return;
  }
  let isStorageCurrent: (() => boolean) | undefined;
  const isCurrent = () => active && load.value === request && currentRoute.value === route
    && (isStorageCurrent === undefined || isStorageCurrent());
  try {
    isStorageCurrent = storageService.captureSettingsStorage();
    const chat = messageId
      ? await chatNavigation.openChatAtMessage({ chatId: toChatId({ raw: id }), messageId, isCurrent })
      : await chatNavigation.openChat({ chatId: toChatId({ raw: id }), leafId: leafId === undefined ? undefined : toMessageId({ raw: leafId }), isCurrent });
    if (!isCurrent()) {
      return;
    }
    if (chat === null) {
      // Commands for a missing chat must not become root-level auto-send commands.
      const failure = await router.replace({ path: '/', query: {}, hash: '' });
      if (failure && isCurrent()) {
        throw new Error('Could not leave a missing chat');
      }
      return;
    }
    load.value = { ...request, status: 'ready' };
  } catch (error) {
    if (!isCurrent()) {
      return;
    }
    console.error('Failed to load chat:', error);
    load.value = { ...request, status: 'error' };
  }
}

function handleAutoSent() {
  switch (loadStatus.value) {
  case 'loading':
  case 'error':
    return;
  case 'ready':
    break;
  default: {
    const _ex: never = loadStatus.value;
    throw new Error(`Unhandled chat load status: ${_ex}`);
  }
  }
  const query = { ...currentRoute.value?.query };
  delete query.q;
  router.replace({ query });
}

watch(currentRoute, syncChat, { immediate: true });
const unsubscribeStorage = storageService.subscribeToChanges({
  listener: ({ event }) => {
    switch (event.type) {
    case 'migration': void syncChat();
      break;
    case 'chat_content': case 'chat_meta_and_chat_group': case 'chat_content_generation': case 'settings': case 'binary_objects': case 'naidan_rpc_registry': break;
    default: {
      const exhaustive: never = event;
      throw new Error(String(exhaustive));
    }
    }
  },
});
onScopeDispose(() => {
  active = false;
  unsubscribeStorage();
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <template v-if="chatId">
    <!-- Keep the previous pane mounted to retain its draft and attachment URLs while a read fails. -->
    <div
      v-show="loadStatus === 'ready'"
      :inert="loadStatus !== 'ready'"
      data-testid="chat-page-content"
      tw-class="h-full w-full"
    >
      <CurrentChatPane
        :auto-send-prompt="loadStatus === 'ready' ? currentRoute?.query?.q?.toString() : undefined"
        :target-message-id="loadStatus === 'ready' ? messageId : undefined"
        @auto-sent="handleAutoSent"
      />
    </div>
    <div
      v-if="loadStatus !== 'ready'"
      tw-class="h-full flex flex-col items-center justify-center gap-4 p-6 bg-[#fcfcfd] dark:bg-gray-900 text-gray-500 dark:text-gray-400 text-center"
    >
      <template v-if="loadStatus === 'error'">
        <p role="alert" data-testid="chat-load-error">{{ lazyStrings.ChatPage__failed_to_load_chat() }}</p>
        <button
          type="button"
          data-testid="chat-load-retry"
          tw-class="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          @click="syncChat"
        >{{ lazyStrings.ChatPage__retry() }}</button>
      </template>
      <p v-else role="status">{{ lazyStrings.ChatPage__loading_chat() }}</p>
    </div>
  </template>
</template>

<style scoped>
.fade-enter-active {
  transition: opacity 0.15s ease-out, transform 0.15s ease-out;
}

.fade-enter-from {
  opacity: 0;
  transform: translateY(2px);
}

/* We don't use leave-active to keep navigation instant */
</style>
