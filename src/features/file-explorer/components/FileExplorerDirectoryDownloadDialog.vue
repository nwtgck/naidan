<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import {
  DownloadIcon,
  FileIcon,
  FolderIcon,
  Loader2Icon,
  PlusIcon,
  XIcon,
} from 'lucide-vue-next';

import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import { lazyStrings } from '@/strings';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;
const controller = ctx.directoryDownload;
const state = controller.state;
const archiveNameInput = ref<HTMLInputElement>();
const exclusionControl = ref<HTMLElement>();

function getSuggestionOptionId({ index }: { index: number }): string {
  return `directory-download-suggestion-${index}`;
}

const activeSuggestionId = computed(() => {
  const index = state.selectedSuggestionIndex;
  return index === undefined ? undefined : getSuggestionOptionId({ index });
});

watch(
  () => state.visibility,
  async (visibility) => {
    switch (visibility) {
    case 'hidden':
      return;
    case 'visible':
      await nextTick();
      archiveNameInput.value?.focus();
      archiveNameInput.value?.select();
      return;
    default: {
      const _ex: never = visibility;
      throw new Error(`Unhandled directory download visibility: ${String(_ex)}`);
    }
    }
  },
);

function handleSuggestionInputKeyDown({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing) {
    return;
  }
  switch (event.key) {
  case 'ArrowUp':
    event.preventDefault();
    controller.moveSuggestionSelection({ direction: 'previous' });
    break;
  case 'ArrowDown':
    event.preventDefault();
    controller.moveSuggestionSelection({ direction: 'next' });
    break;
  case 'Enter':
    event.preventDefault();
    if (state.querySuggestion !== undefined) {
      controller.addQueryExclusion();
    } else {
      controller.applySelectedSuggestion();
    }
    break;
  case 'Tab':
    if (state.selectedSuggestionIndex !== undefined) {
      event.preventDefault();
      controller.applySelectedSuggestion();
    }
    break;
  case 'Escape':
    event.preventDefault();
    event.stopPropagation();
    switch (state.suggestionStatus) {
    case 'idle':
      void controller.close();
      break;
    case 'loading':
    case 'ready':
    case 'error':
      controller.closeSuggestions();
      break;
    default: {
      const _ex: never = state.suggestionStatus;
      throw new Error(`Unhandled directory download suggestion status: ${String(_ex)}`);
    }
    }
    break;
  default:
    break;
  }
}

function handleExclusionFocusOut({ event }: { event: FocusEvent }): void {
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && exclusionControl.value?.contains(nextTarget)) {
    return;
  }
  controller.closeSuggestions();
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      handleSuggestionInputKeyDown,
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.visibility === 'visible'"
      class="fixed inset-0 z-[600] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      data-testid="directory-download-overlay"
      @click.self="controller.close()"
      @keydown.esc.stop.prevent="controller.close()"
    >
      <section
        class="w-full max-w-[560px] overflow-visible bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-2xl"
        role="dialog"
        aria-modal="true"
        :aria-label="lazyStrings.fileExplorer__download_directory()"
        data-testid="directory-download-dialog"
      >
        <header class="flex items-center justify-between min-h-[50px] px-4 py-2.5 border-b border-gray-200 dark:border-gray-700">
          <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-300">
            {{ lazyStrings.fileExplorer__download_directory() }}
          </h2>
          <button
            type="button"
            class="grid place-items-center w-7 h-7 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
            :aria-label="lazyStrings.fileExplorer__close()"
            data-testid="directory-download-close"
            @click="controller.close()"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </header>

        <div class="grid gap-5 px-5 py-[18px]">
          <label class="grid gap-2">
            <span class="text-xs font-bold text-gray-700 dark:text-gray-300">
              {{ lazyStrings.fileExplorer__archive_name() }}
            </span>
            <span class="flex items-stretch">
              <input
                ref="archiveNameInput"
                :value="state.archiveName"
                type="text"
                class="min-w-0 flex-1 h-[38px] px-3 text-xs text-gray-700 dark:text-gray-300 bg-transparent border border-gray-200 dark:border-gray-700 rounded-l-lg outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 disabled:opacity-50"
                :disabled="state.creationStatus === 'creating'"
                data-testid="directory-download-archive-name"
                @input="controller.setArchiveName({ value: ($event.target as HTMLInputElement).value })"
              />
              <span class="flex items-center px-3 text-[11px] font-mono text-gray-400 bg-gray-50 dark:bg-gray-900/80 border border-l-0 border-gray-200 dark:border-gray-700 rounded-r-lg">
                .zip
              </span>
            </span>
          </label>

          <div class="grid gap-2">
            <div class="flex items-baseline justify-between gap-3">
              <span class="text-xs font-bold text-gray-700 dark:text-gray-300">
                {{ lazyStrings.fileExplorer__exclude_items() }}
              </span>
              <span class="text-[10px] text-gray-400">
                {{ lazyStrings.fileExplorer__optional() }}
              </span>
            </div>

            <div
              ref="exclusionControl"
              @focusout="handleExclusionFocusOut({ event: $event })"
            >
              <div class="min-h-[72px] p-2 bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/15">
                <div v-if="state.exclusions.length > 0" class="flex flex-wrap gap-1.5 mb-1.5">
                  <span
                    v-for="exclusion in state.exclusions"
                    :key="exclusion.relativePath"
                    class="inline-flex items-center gap-1.5 max-w-full min-h-[25px] px-2 py-1 text-[11px] font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 rounded-md"
                    data-testid="directory-download-exclusion-chip"
                  >
                    <FolderIcon v-if="exclusion.kind === 'directory'" class="w-3 h-3 shrink-0" />
                    <FileIcon v-else class="w-3 h-3 shrink-0" />
                    <span class="truncate">{{ exclusion.relativePath }}{{ exclusion.kind === 'directory' ? '/' : '' }}</span>
                    <button
                      type="button"
                      class="grid place-items-center w-[18px] h-[18px] shrink-0 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800 rounded"
                      :disabled="state.creationStatus === 'creating'"
                      :aria-label="lazyStrings.fileExplorer__delete()"
                      @click="controller.removeExclusion({ relativePath: exclusion.relativePath })"
                    >
                      <XIcon class="w-3 h-3" />
                    </button>
                  </span>
                </div>

                <div class="flex items-center gap-2 min-h-[27px]">
                  <PlusIcon class="w-4 h-4 shrink-0 text-gray-400" />
                  <input
                    :value="state.query"
                    type="text"
                    class="w-full min-w-0 py-1 text-[11px] font-mono text-gray-700 dark:text-gray-300 bg-transparent border-0 outline-none placeholder:text-gray-400"
                    :placeholder="lazyStrings.fileExplorer__relative_path()"
                    :disabled="state.creationStatus === 'creating'"
                    role="combobox"
                    aria-autocomplete="list"
                    :aria-expanded="state.suggestionStatus !== 'idle' && state.creationStatus !== 'creating'"
                    aria-controls="directory-download-suggestions"
                    :aria-activedescendant="activeSuggestionId"
                    data-testid="directory-download-exclusion-input"
                    @focus="controller.openSuggestions()"
                    @input="controller.setQuery({ value: ($event.target as HTMLInputElement).value })"
                    @keydown="handleSuggestionInputKeyDown({ event: $event })"
                  />
                  <button
                    type="button"
                    class="shrink-0 min-h-[26px] px-2.5 text-[10px] font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 rounded-md hover:bg-blue-100 dark:hover:bg-blue-950/70 disabled:opacity-40 disabled:cursor-not-allowed"
                    :disabled="state.querySuggestion === undefined || state.creationStatus === 'creating'"
                    data-testid="directory-download-add-exclusion"
                    @click="controller.addQueryExclusion()"
                  >
                    {{ lazyStrings.fileExplorer__add() }}
                  </button>
                </div>
              </div>

              <div
                v-if="state.suggestionStatus !== 'idle' && state.creationStatus !== 'creating'"
                id="directory-download-suggestions"
                class="max-h-40 overflow-y-auto mt-1.5 py-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg"
                role="listbox"
                data-testid="directory-download-suggestions"
              >
                <div
                  v-if="state.suggestionStatus === 'loading'"
                  class="flex items-center gap-2 px-3 py-2 text-[11px] text-gray-400"
                >
                  <Loader2Icon class="w-3.5 h-3.5 animate-spin" />
                </div>
                <div
                  v-else-if="state.suggestionStatus === 'error'"
                  class="px-3 py-2 text-[11px] text-gray-400"
                >
                  {{ lazyStrings.fileExplorer__failed_to_load_exclusion_suggestions() }}
                </div>
                <template v-else-if="state.suggestions.length > 0">
                  <button
                    v-for="(suggestion, index) in state.suggestions"
                    :id="getSuggestionOptionId({ index })"
                    :key="suggestion.relativePath"
                    type="button"
                    class="grid grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 w-full min-h-8 px-3 py-1.5 text-left text-[11px] hover:bg-gray-100 dark:hover:bg-gray-800"
                    :class="index === state.selectedSuggestionIndex ? 'bg-gray-100 dark:bg-gray-800' : ''"
                    role="option"
                    :aria-selected="index === state.selectedSuggestionIndex"
                    data-testid="directory-download-suggestion"
                    @mouseenter="controller.selectSuggestion({ index })"
                    @mousedown.prevent
                    @click="controller.applySuggestion({ suggestion })"
                  >
                    <FolderIcon v-if="suggestion.kind === 'directory'" class="w-4 h-4 text-yellow-500" />
                    <FileIcon v-else class="w-4 h-4 text-gray-400" />
                    <span class="truncate font-mono text-gray-700 dark:text-gray-300">
                      {{ suggestion.relativePath }}{{ suggestion.kind === 'directory' ? '/' : '' }}
                    </span>
                    <span class="text-[10px] text-gray-400">
                      {{ suggestion.kind === 'directory' ? lazyStrings.fileExplorer__folder() : lazyStrings.fileExplorer__file() }}
                    </span>
                  </button>
                  <div
                    v-if="state.suggestionResultState === 'truncated'"
                    class="px-3 py-2 text-[10px] text-gray-400 border-t border-gray-100 dark:border-gray-800"
                  >
                    {{ lazyStrings.fileExplorer__type_to_narrow_results() }}
                  </div>
                </template>
                <div v-else class="px-3 py-2 text-[11px] text-gray-400">
                  {{ lazyStrings.fileExplorer__no_matching_items() }}
                </div>
              </div>
            </div>

            <p class="m-0 text-[10px] leading-4 text-gray-400">
              {{ lazyStrings.fileExplorer__exclude_items_help() }}
            </p>
          </div>
        </div>

        <footer class="flex items-center justify-end gap-2 min-h-[58px] px-4 py-2.5 bg-gray-50/80 dark:bg-gray-950/20 border-t border-gray-200 dark:border-gray-700 rounded-b-2xl">
          <button
            type="button"
            class="min-h-[34px] px-3.5 py-1.5 text-[11px] font-bold text-gray-700 dark:text-gray-300 bg-transparent border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            data-testid="directory-download-cancel"
            @click="controller.close()"
          >
            {{ lazyStrings.SHARED__cancel() }}
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 min-h-[34px] px-3.5 py-1.5 text-[11px] font-bold text-white bg-blue-500 border border-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="state.archiveName.trim() === '' || state.creationStatus === 'creating'"
            data-testid="directory-download-confirm"
            @click="controller.confirm()"
          >
            <Loader2Icon v-if="state.creationStatus === 'creating'" class="w-3.5 h-3.5 animate-spin" />
            <DownloadIcon v-else class="w-3.5 h-3.5" />
            {{ state.creationStatus === 'creating'
              ? lazyStrings.fileExplorer__creating_archive()
              : lazyStrings.fileExplorer__download() }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
