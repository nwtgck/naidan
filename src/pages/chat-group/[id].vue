<script setup lang="ts">
import { computed, onScopeDispose, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import ChatGroupSettingsPanel from '@/components/ChatGroupSettingsPanel.vue';
import { toChatGroupId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { useAppEntry } from '@/composables/useAppEntry';
import { hasModelEntryQuery } from '@/logic/startup/entry-intent';
import { lazyStrings } from '@/strings';

const router = useRouter();
const route = computed(() => router.currentRoute.value);
const chatNavigation = useChatNavigation();
const entry = useAppEntry();
const target = computed(() => {
  const params = route.value.params;
  return 'id' in params && typeof params.id === 'string' && params.id ? toChatGroupId({ raw: params.id }) : undefined;
});
const modelEntry = computed(() => hasModelEntryQuery({ query: route.value.query }));
const load = shallowRef<{ target: typeof target.value, status: 'loading' | 'ready' | 'error' }>();
const loadStatus = computed(() => {
  const current = load.value;
  return current !== undefined && current.target === target.value && !modelEntry.value ? current.status : 'loading';
});
let active = true;

async function syncGroup(): Promise<void> {
  if (!active || modelEntry.value) {
    return;
  }
  const request = { target: target.value, status: 'loading' as const };
  load.value = request;
  let isStorageCurrent: (() => boolean) | undefined;
  const isCurrent = () => active && load.value === request && target.value === request.target && !modelEntry.value && (isStorageCurrent === undefined || isStorageCurrent());
  try {
    isStorageCurrent = storageService.captureSettingsStorage();
    if (request.target === undefined) {
      return;
    }
    const chatGroup = await chatNavigation.loadAndOpenChatGroup({ groupId: request.target, isCurrent });
    if (!isCurrent()) {
      return;
    }
    if (chatGroup === null) {
      await entry.recoverNotFound({ isCurrent });
      return;
    }
    load.value = { ...request, status: 'ready' };
  } catch (error) {
    if (!isCurrent()) {
      return;
    }
    console.error('Failed to load chat group:', error);
    load.value = { ...request, status: 'error' };
  }
}

watch([target, modelEntry], () => {
  void syncGroup();
}, { immediate: true });
const unsubscribe = storageService.subscribeToChanges({
  listener: ({ event }) => {
    switch (event.type) {
    case 'migration': void syncGroup();
      return;
    case 'chat_content': case 'chat_meta_and_chat_group': case 'chat_content_generation': case 'settings': case 'binary_objects': case 'naidan_rpc_registry': return;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
    }
  },
});
onScopeDispose(() => {
  active = false;
  unsubscribe();
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
  <div tw-class="h-full flex flex-col overflow-hidden bg-[#fcfcfd] dark:bg-gray-900 transition-colors">
    <div v-show="loadStatus === 'ready'" :inert="loadStatus !== 'ready' || undefined" data-testid="chat-group-page-content" tw-class="h-full w-full"><ChatGroupSettingsPanel /></div>
    <div v-if="loadStatus !== 'ready'" tw-class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-gray-500 dark:text-gray-400">
      <template v-if="loadStatus === 'error'">
        <p role="alert" data-testid="chat-group-load-error">{{ lazyStrings.ChatGroupPage__failed_to_load_chat_group() }}</p>
        <button type="button" data-testid="chat-group-load-retry" tw-class="rounded-lg border border-gray-200 bg-white px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700" @click="syncGroup">{{ lazyStrings.ChatGroupPage__retry() }}</button>
      </template>
      <p v-else role="status">{{ lazyStrings.ChatGroupPage__loading_chat_group() }}</p>
    </div>
  </div>
</template>
