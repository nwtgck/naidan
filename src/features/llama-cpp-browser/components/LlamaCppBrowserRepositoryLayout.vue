<script setup lang="ts">
import { FolderOpenIcon, ChevronRightIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalRepositoryLayoutChoice } from '@/features/llama-cpp-browser/runtime/local-repository-layout';
import { useLlamaCppBrowserSettingsTypography } from '@/features/llama-cpp-browser/composables/useLlamaCppBrowserSettingsTypography';

defineProps<{ rootName: string, choices: readonly { layout: LocalRepositoryLayoutChoice['layout'], directories: readonly { rootName: string }[] }[], heading: 'visible' | 'hidden' }>();
const emit = defineEmits<{ choose: [layout: LocalRepositoryLayoutChoice['layout']], cancel: [] }>();
const isSettingsTypography = useLlamaCppBrowserSettingsTypography();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section data-testid="local-model-repository-layout" tw-class="min-h-0 space-y-3 overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
    <div v-if="heading === 'visible'" tw-class="flex items-center gap-2"><FolderOpenIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500" /><h4 :tw-class="['text-sm font-medium text-gray-800', isSettingsTypography ? 'dark:text-gray-300' : 'dark:text-gray-100']">{{ lazyStrings.LlamaCppBrowserRepositoryLayout__confirm_folder_layout() }}</h4></div>
    <code tw-class="block break-all text-xs text-gray-500 dark:text-gray-400">{{ rootName }}/</code>
    <p :tw-class="['leading-relaxed text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-sm' : 'text-xs']">{{ lazyStrings.LlamaCppBrowserRepositoryLayout__keep_models_and_companion_files_in_the_same_repository() }}</p>
    <div tw-class="space-y-2">
      <button v-for="choice in choices" :key="choice.layout" type="button" :data-testid="`local-model-layout-${choice.layout}`" tw-class="flex w-full items-center gap-3 rounded-xl border border-gray-200 px-3 py-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50/50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:hover:border-blue-500/50 dark:hover:bg-blue-500/5" @click="emit('choose', choice.layout)">
        <span tw-class="min-w-0 flex-1"><span :tw-class="['block font-medium text-gray-700', isSettingsTypography ? 'text-sm dark:text-gray-300' : 'text-xs dark:text-gray-200']">{{ choice.layout === 'repository' ? lazyStrings.LlamaCppBrowserRepositoryLayout__open_this_folder_as_one_repository() : choice.layout === 'repositories' ? lazyStrings.LlamaCppBrowserRepositoryLayout__open_each_child_folder_as_a_repository() : lazyStrings.LlamaCppBrowserRepositoryLayout__open_repositories_inside_owner_folders() }}</span><span :tw-class="['mt-1 block truncate text-gray-500 dark:text-gray-400', isSettingsTypography ? 'text-xs' : 'text-[11px]']">{{ choice.directories.map(directory => directory.rootName).join(' · ') }}</span></span><ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" />
      </button>
    </div>
    <div tw-class="flex justify-end"><button type="button" data-testid="local-model-layout-cancel" :tw-class="['min-h-8 rounded-lg px-3 text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800', isSettingsTypography ? 'text-sm' : 'text-xs']" @click="emit('cancel')">{{ lazyStrings.SHARED__cancel() }}</button></div>
  </section>
</template>
