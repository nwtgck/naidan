<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { FolderOpenIcon, SearchXIcon } from 'lucide-vue-next';

defineProps<{
  density: 'compact' | 'comfortable',
  kind: 'empty-folder' | 'no-matching-results',
}>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div role="status" :tw-class="[
    'flex flex-col items-center justify-center px-4 text-center',
    density === 'compact' ? 'gap-2.5 py-7' : 'min-h-full gap-4 py-12',
  ]" data-testid="file-explorer-empty">
    <span aria-hidden="true" :tw-class="[
      'grid place-items-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-400/10 dark:text-blue-300',
      density === 'compact' ? 'h-9 w-9' : 'h-14 w-14',
    ]">
      <component :is="kind === 'empty-folder' ? FolderOpenIcon : SearchXIcon" :tw-class="density === 'compact' ? 'h-4 w-4' : 'h-6 w-6'" />
    </span>
    <p :tw-class="['max-w-xs break-words font-medium text-slate-600 dark:text-slate-300', density === 'compact' ? 'text-xs' : 'text-sm']">
      {{ kind === 'empty-folder' ? lazyStrings.fileExplorer__empty_folder() : lazyStrings.fileExplorer__no_matching_items() }}
    </p>
  </div>
</template>
