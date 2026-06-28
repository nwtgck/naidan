<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { XIcon, SparklesIcon, SquareIcon } from 'lucide-vue-next';
import ModelSelector from './ModelSelector.vue';
import { UNTITLED_CHAT_TITLE } from '@/models/constants';
import { lazyStrings } from '@/strings';

let rememberedDetailVisibility: 'hidden' | 'visible' = 'hidden';

const props = defineProps<{
  isOpen: boolean,
  title: string | null,
  availableModels: readonly string[],
  selectedTitleModel: string | undefined,
  titleModelSource: 'chat' | 'chat_group' | 'global',
  generatedTitles: readonly string[],
  generatingTitle: boolean,
  fetchingModels: boolean,
}>();

const emit = defineEmits<{
  (e: 'close'): void,
  (e: 'save-title', title: string): void,
  (e: 'generate-title', modelId: string | undefined): void,
  (e: 'abort-title'): void,
  (e: 'refresh-models'): void,
}>();

const titleInput = ref('');
const selectedTitleModelDraft = ref<string | undefined>(undefined);
const suppressTitleAutosave = ref(false);
const detailVisibility = ref<'hidden' | 'visible'>('hidden');
let titleAutosaveTimer: ReturnType<typeof setTimeout> | undefined;

const trimmedTitle = computed(() => titleInput.value.trim());

watch(
  () => props.isOpen,
  (isOpen) => {
    if (!isOpen) return;
    suppressTitleAutosave.value = true;
    titleInput.value = props.title || '';
    selectedTitleModelDraft.value = props.selectedTitleModel;
    detailVisibility.value = rememberedDetailVisibility;
    queueMicrotask(() => {
      suppressTitleAutosave.value = false;
    });
  },
  { immediate: true },
);

watch(
  () => props.selectedTitleModel,
  (modelId) => {
    if (!props.isOpen) return;
    selectedTitleModelDraft.value = modelId;
  },
);

watch(
  titleInput,
  () => {
    if (!props.isOpen || suppressTitleAutosave.value) return;
    if (titleAutosaveTimer) clearTimeout(titleAutosaveTimer);
    titleAutosaveTimer = setTimeout(() => {
      const nextTitle = trimmedTitle.value || UNTITLED_CHAT_TITLE;
      if (nextTitle === (props.title || '')) return;
      emit('save-title', nextTitle);
    }, 500);
  },
);

watch(
  () => props.generatedTitles[0],
  (title) => {
    if (!props.isOpen || !title) return;
    suppressTitleAutosave.value = true;
    titleInput.value = title;
    queueMicrotask(() => {
      suppressTitleAutosave.value = false;
    });
  },
);

function emitGenerateTitle() {
  emit('generate-title', selectedTitleModelDraft.value);
}

function selectGeneratedTitle({ title }: { title: string }) {
  titleInput.value = title;
  emit('save-title', title);
}

function titleModelSourceLabel({ source }: { source: 'chat' | 'chat_group' | 'global' }) {
  switch (source) {
  case 'chat':
    return lazyStrings.ChatTitleDialog__chat_override();
  case 'chat_group':
    return lazyStrings.ChatTitleDialog__group_override();
  case 'global':
    return lazyStrings.ChatTitleDialog__global_default();
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled title model source: ${_ex}`);
  }
  }
}

function activeTitleModelSourceDescription(): string | undefined {
  const sourceLabel = titleModelSourceLabel({ source: props.titleModelSource });
  if (sourceLabel === undefined) return undefined;
  return lazyStrings.ChatTitleDialog__editing_source_because_that_is_the_active_source_for_this_chat({ sourceLabel });
}

function toggleDetails() {
  const currentVisibility = detailVisibility.value;
  switch (currentVisibility) {
  case 'hidden':
    detailVisibility.value = 'visible';
    rememberedDetailVisibility = 'visible';
    return;
  case 'visible':
    detailVisibility.value = 'hidden';
    rememberedDetailVisibility = 'hidden';
    return;
  default: {
    const _ex: never = currentVisibility;
    throw new Error(`Unhandled title dialog detail visibility: ${_ex}`);
  }
  }
}

onBeforeUnmount(() => {
  if (titleAutosaveTimer) clearTimeout(titleAutosaveTimer);
});

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <Transition name="modal">
    <div
      v-if="isOpen"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 dark:bg-black/50 backdrop-blur-sm px-4"
      data-testid="chat-title-dialog"
      @click.self="emit('close')"
    >
      <div class="w-full max-w-lg bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
          <div>
            <h3 class="text-sm font-bold text-gray-900 dark:text-gray-100">{{ lazyStrings.ChatTitleDialog__chat_title() }}</h3>
            <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{{ lazyStrings.ChatTitleDialog__edit_the_title_directly_or_generate_a_new_one_from_the_conversation() }}</p>
          </div>
          <button
            type="button"
            class="p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            :title="lazyStrings.ChatTitleDialog__close()"
            data-testid="chat-title-dialog-close"
            @click="emit('close')"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>

        <div class="p-5 space-y-5">
          <div class="space-y-2">
            <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatTitleDialog__title() }}</label>
            <div class="relative">
              <input
                v-model="titleInput"
                type="text"
                class="w-full px-3 py-2.5 rounded-xl bg-gray-50 dark:bg-gray-800 border text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                :class="generatingTitle
                  ? 'border-blue-300 dark:border-blue-700 shadow-lg shadow-blue-500/10'
                  : 'border-gray-100 dark:border-gray-700'"
                :placeholder="lazyStrings.SHARED__new_chat()"
                data-testid="chat-title-input"
              />
              <div v-if="generatingTitle" class="title-scan-overlay pointer-events-none absolute inset-0 overflow-hidden rounded-xl" data-testid="title-magic-scan">
                <span class="title-scan-beam absolute inset-y-0 w-1/3"></span>
              </div>
            </div>
            <div class="h-9 flex flex-wrap justify-end gap-2">
              <button
                v-if="generatingTitle"
                type="button"
                class="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/50 transition-colors"
                data-testid="abort-title-generation-button"
                @click="emit('abort-title')"
              >
                <SquareIcon class="w-3.5 h-3.5" />
                <span>{{ lazyStrings.ChatTitleDialog__stop() }}</span>
              </button>
              <button
                v-else
                type="button"
                class="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                data-testid="generate-chat-title-button"
                @click="emitGenerateTitle()"
              >
                <SparklesIcon class="w-3.5 h-3.5" />
                <span>{{ lazyStrings.ChatTitleDialog__generate() }}</span>
              </button>
            </div>
          </div>

          <div class="border-t border-gray-100 dark:border-gray-800 pt-3">
            <button
              type="button"
              class="w-full flex items-center justify-between px-1 py-1 text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              data-testid="title-options-toggle"
              @click="toggleDetails()"
            >
              <span>{{ lazyStrings.ChatTitleDialog__options_and_history() }}</span>
              <span>{{ detailVisibility === 'visible' ? lazyStrings.ChatTitleDialog__hide() : lazyStrings.ChatTitleDialog__show() }}</span>
            </button>

            <div v-if="detailVisibility === 'visible'" class="mt-3 space-y-5">
              <div class="space-y-3 p-4 rounded-xl bg-blue-50/50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30">
                <div>
                  <h4 class="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest">{{ lazyStrings.ChatTitleDialog__title_model() }}</h4>
                  <p class="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
                    {{ activeTitleModelSourceDescription() }}
                  </p>
                </div>

                <div class="space-y-2">
                  <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatTitleDialog__title_model() }}</label>
                  <ModelSelector
                    v-model="selectedTitleModelDraft"
                    :models="availableModels"
                    :loading="fetchingModels"
                    :allow-clear="true"
                    :clear-label="lazyStrings.ChatTitleDialog__use_chat_model()"
                    :placeholder="lazyStrings.ChatTitleDialog__use_chat_model()"
                    data-testid="chat-title-model-select"
                    @refresh="emit('refresh-models')"
                  />
                </div>
              </div>

              <div class="space-y-2">
                <label class="block text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">{{ lazyStrings.ChatTitleDialog__generated_in_this_dialog() }}</label>
                <div class="h-36 space-y-2 overflow-y-auto pr-1">
                  <div
                    v-if="generatedTitles.length === 0"
                    class="h-full flex items-center justify-center rounded-xl border border-dashed border-gray-200 dark:border-gray-700 text-[11px] text-gray-400 dark:text-gray-500"
                  >
                    {{ lazyStrings.ChatTitleDialog__generated_titles_will_appear_here() }}
                  </div>
                  <div
                    v-for="titleOption in generatedTitles"
                    :key="titleOption"
                    class="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700"
                  >
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left text-xs text-gray-700 dark:text-gray-200 truncate"
                      data-testid="generated-title-option"
                      @click="selectGeneratedTitle({ title: titleOption })"
                    >
                      {{ titleOption }}
                    </button>
                    <button
                      type="button"
                      class="shrink-0 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                      data-testid="use-generated-title-button"
                      @click="selectGeneratedTitle({ title: titleOption })"
                    >
                      {{ lazyStrings.ChatTitleDialog__use() }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.title-scan-overlay {
  border: 1px solid rgba(96, 165, 250, 0.42);
  box-shadow:
    inset 0 0 18px rgba(59, 130, 246, 0.14),
    0 0 16px rgba(59, 130, 246, 0.14);
}

.title-scan-beam {
  left: -18%;
  background:
    linear-gradient(90deg, transparent 0%, rgba(191, 219, 254, 0.08) 20%, rgba(147, 197, 253, 0.42) 48%, rgba(255, 255, 255, 0.7) 52%, rgba(129, 140, 248, 0.25) 70%, transparent 100%);
  filter: blur(0.5px);
  transform: skewX(-18deg);
  animation: title-scan 2.2s cubic-bezier(0.42, 0, 0.18, 1) infinite;
}

@keyframes title-scan {
  0% {
    left: -18%;
  }
  70% {
    left: 112%;
  }
  100% {
    left: 112%;
  }
}
</style>
