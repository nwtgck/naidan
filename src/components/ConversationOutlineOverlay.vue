<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { EyeIcon, ListIcon, XIcon } from 'lucide-vue-next';
import type { ChatFlowItem } from '@/composables/useChatDisplayFlow';
import type { MessageNode } from '@/models/types';
import { scrollIntoViewSafe } from '@/utils/dom';
import MessageItem from './MessageItem.vue';

type OutlineVisibility = 'hidden' | 'visible';
type OutlineRole = MessageNode['role'];
type ScrollHintVisibility = 'hidden' | 'visible';

const props = defineProps<{
  chatId: string;
  visibility: OutlineVisibility;
  flowItems: ChatFlowItem[];
  initialMessageId?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'select-message', messageId: string): void;
}>();

const peekMessageId = ref<string | undefined>(undefined);
const outlineBody = ref<HTMLElement | null>(null);
const topScrollHintVisibility = ref<ScrollHintVisibility>('hidden');
const bottomScrollHintVisibility = ref<ScrollHintVisibility>('hidden');

const outlineItems = computed(() => {
  return props.flowItems
    .filter((item): item is Extract<ChatFlowItem, { type: 'message' }> => item.type === 'message' && item.mode === 'content')
    .map((item, index) => {
      const rawContent = (item.partContent || item.node.content || '').replace(/\s+/g, ' ').trim();
      return {
        id: item.node.id,
        role: item.node.role,
        node: item.node,
        partContent: item.partContent,
        preview: rawContent || '(empty message)',
        peek: item.partContent || item.node.content || '',
        index: index + 1,
      };
    });
});

const outlineMaxHeightClass = computed(() => {
  return peekMessageId.value === undefined ? 'max-h-[55vh]' : 'max-h-[80vh]';
});

const outlineBodyMaxHeightClass = computed(() => {
  return peekMessageId.value === undefined ? 'max-h-[calc(55vh-41px)]' : 'max-h-[calc(80vh-41px)]';
});

function updateScrollHints(_args: Record<never, never>) {
  const body = outlineBody.value;
  if (!body) {
    topScrollHintVisibility.value = 'hidden';
    bottomScrollHintVisibility.value = 'hidden';
    return;
  }

  topScrollHintVisibility.value = body.scrollTop > 1 ? 'visible' : 'hidden';
  bottomScrollHintVisibility.value = body.scrollTop + body.clientHeight < body.scrollHeight - 1 ? 'visible' : 'hidden';
}

function scrollToInitialMessage(_args: Record<never, never>) {
  const body = outlineBody.value;
  const initialMessageId = props.initialMessageId;
  if (!body || !initialMessageId) {
    updateScrollHints({});
    return;
  }

  const rows = Array.from(body.querySelectorAll('[data-outline-message-id]'));
  const target = rows.find((row) => {
    if (!(row instanceof HTMLElement)) return false;
    return row.dataset.outlineMessageId === initialMessageId;
  });

  if (target instanceof HTMLElement) {
    scrollIntoViewSafe({
      container: body,
      element: target,
      block: 'center',
      behavior: 'instant',
    });
  }
  updateScrollHints({});
}

watch([() => props.visibility, () => props.initialMessageId, outlineItems], () => {
  nextTick(() => scrollToInitialMessage({}));
}, { immediate: true });

watch(peekMessageId, () => {
  nextTick(() => updateScrollHints({}));
});

function togglePeek({ messageId }: { messageId: string }) {
  const currentPeekMessageId = peekMessageId.value;
  if (currentPeekMessageId === messageId) {
    peekMessageId.value = undefined;
    return;
  }
  peekMessageId.value = messageId;
}

function formatRole({ role }: { role: OutlineRole }) {
  switch (role) {
  case 'user':
    return 'You';
  case 'assistant':
    return 'AI';
  case 'system':
    return 'System';
  case 'tool':
    return 'Tool';
  default: {
    const _ex: never = role;
    return _ex;
  }
  }
}

function roleClass({ role }: { role: OutlineRole }) {
  switch (role) {
  case 'user':
    return 'text-blue-600 dark:text-blue-400';
  case 'assistant':
    return 'text-emerald-600 dark:text-emerald-400';
  case 'system':
    return 'text-purple-600 dark:text-purple-400';
  case 'tool':
    return 'text-amber-600 dark:text-amber-400';
  default: {
    const _ex: never = role;
    return _ex;
  }
  }
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition name="dropdown">
    <div
      v-if="visibility === 'visible'"
      class="absolute inset-0 z-40"
      data-testid="conversation-outline-overlay"
    >
      <div
        class="absolute inset-0 bg-black/10 backdrop-blur-[1px] transition-opacity dark:bg-black/30"
        aria-hidden="true"
        data-testid="conversation-outline-backdrop"
        @click="emit('close')"
      />
      <div
        class="absolute left-3 right-3 top-3 overflow-hidden rounded-xl border border-gray-200/80 bg-white/95 shadow-2xl backdrop-blur-md transition-[max-height] duration-150 ease-out dark:border-gray-700 dark:bg-gray-900/95"
        :class="outlineMaxHeightClass"
        data-testid="conversation-outline-panel"
        @click.stop
      >
        <div class="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800">
          <div class="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <ListIcon class="h-4 w-4" />
            <span>Conversation Outline</span>
          </div>
          <button
            @click="emit('close')"
            class="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            title="Close Conversation Outline"
            data-testid="close-conversation-outline-button"
          >
            <XIcon class="h-4 w-4" />
          </button>
        </div>
        <div class="relative">
          <div
            ref="outlineBody"
            @scroll="updateScrollHints({})"
            class="overflow-y-auto py-1 transition-[max-height] duration-150 ease-out"
            :class="outlineBodyMaxHeightClass"
            data-testid="conversation-outline-body"
          >
            <div
              v-for="item in outlineItems"
              :key="item.id"
              class="border-b border-gray-100 last:border-b-0 dark:border-gray-800"
              data-testid="conversation-outline-item"
              :data-outline-message-id="item.id"
            >
              <div class="grid grid-cols-[2.25rem_2.5rem_minmax(0,1fr)_2rem] items-center gap-1.5 px-3 py-2 text-sm transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20">
                <button
                  @click="emit('select-message', item.id)"
                  class="contents text-left"
                  data-testid="conversation-outline-jump-button"
                >
                  <span class="font-mono text-xs text-gray-400">{{ String(item.index).padStart(2, '0') }}</span>
                  <span
                    class="text-xs font-bold uppercase tracking-wider"
                    :class="roleClass({ role: item.role })"
                  >
                    {{ formatRole({ role: item.role }) }}
                  </span>
                  <span class="truncate text-gray-700 dark:text-gray-200">{{ item.preview }}</span>
                </button>
                <button
                  @click="togglePeek({ messageId: item.id })"
                  class="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white hover:text-blue-600 dark:hover:bg-gray-800 dark:hover:text-blue-400"
                  :class="peekMessageId === item.id ? 'text-blue-600 dark:text-blue-400' : ''"
                  title="Peek"
                  data-testid="conversation-outline-peek-button"
                >
                  <EyeIcon class="h-4 w-4" />
                </button>
              </div>
              <Transition
                enter-active-class="transition duration-150 ease-out"
                enter-from-class="-translate-y-1 opacity-0"
                enter-to-class="translate-y-0 opacity-100"
                leave-active-class="transition duration-100 ease-in"
                leave-from-class="translate-y-0 opacity-100"
                leave-to-class="-translate-y-1 opacity-0"
              >
                <div
                  v-if="peekMessageId === item.id"
                  class="mx-3 mb-3 max-h-72 overflow-y-auto rounded-lg border border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-950/60"
                  data-testid="conversation-outline-peek"
                >
                  <MessageItem
                    :chat-id="props.chatId"
                    :message="item.node"
                    :part-content="item.partContent"
                    :flow="{ position: 'standalone', nesting: 'none' }"
                    :mode="'content'"
                    :siblings="[]"
                    :can-generate-image="false"
                    :is-processing="false"
                    :is-generating="false"
                    :available-image-models="[]"
                    :is-first-in-node="true"
                    :is-last-in-node="true"
                    :is-first-in-turn="true"
                    @fork="() => {}"
                    @edit="() => {}"
                    @switch-version="() => {}"
                    @regenerate="() => {}"
                    @abort="() => {}"
                  />
                </div>
              </Transition>
            </div>
          </div>
          <div
            v-if="topScrollHintVisibility === 'visible'"
            class="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-white/95 to-transparent dark:from-gray-900/95"
            data-testid="conversation-outline-scroll-hint-top"
          ></div>
          <div
            v-if="bottomScrollHintVisibility === 'visible'"
            class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white/95 to-transparent dark:from-gray-900/95"
            data-testid="conversation-outline-scroll-hint-bottom"
          ></div>
        </div>
      </div>
    </div>
  </Transition>
</template>
