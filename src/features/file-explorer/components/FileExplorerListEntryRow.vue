<script setup lang="ts">
import { LockIcon } from 'lucide-vue-next';

import FileExplorerEntryIcon from './FileExplorerEntryIcon.vue';
import type {
  FileExplorerEntry,
  FileExplorerListEntryAppearance,
} from '@/features/file-explorer/logic/types';

const props = defineProps<{
  entry: FileExplorerEntry,
  appearance: FileExplorerListEntryAppearance,
}>();

function getAppearanceClasses(): string {
  switch (props.appearance) {
  case 'default':
    return 'hover:bg-gray-50 dark:hover:bg-gray-800/60';
  case 'selected':
    return 'bg-blue-500 text-white';
  case 'focused':
    return 'bg-gray-100 dark:bg-gray-800';
  case 'planned':
    return 'bg-blue-50/70 dark:bg-blue-950/25 ring-1 ring-inset ring-dashed ring-blue-400/70';
  case 'warning':
    return 'bg-amber-50 dark:bg-amber-950/25 ring-1 ring-inset ring-dashed ring-amber-400/80';
  case 'blocked':
    return 'bg-red-50 dark:bg-red-950/25 ring-1 ring-inset ring-dashed ring-red-400/80';
  default: {
    const _exhaustiveCheck: never = props.appearance;
    throw new Error(`Unhandled entry row appearance: ${String(_exhaustiveCheck)}`);
  }
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {})
});
</script>

<template>
  <div
    class="group flex items-center gap-3 px-3 py-0 h-9 select-none rounded-md transition-all"
    :class="getAppearanceClasses()"
  >
    <FileExplorerEntryIcon
      :kind="entry.kind"
      :extension="entry.extension"
      :mime-category="entry.mimeCategory"
      size="sm"
    />

    <div class="flex-1 min-w-0">
      <slot name="name">
        <span
          class="text-xs truncate block"
          :class="appearance === 'selected'
            ? 'text-white'
            : appearance === 'planned'
              ? 'text-blue-700 dark:text-blue-300'
              : appearance === 'warning'
                ? 'text-amber-700 dark:text-amber-300'
                : appearance === 'blocked'
                  ? 'text-red-700 dark:text-red-300'
                  : 'text-gray-800 dark:text-gray-200'"
        >
          {{ entry.name }}
        </span>
      </slot>
    </div>

    <LockIcon
      v-if="entry.readOnly"
      class="w-2.5 h-2.5 shrink-0 opacity-50"
      :class="appearance === 'selected' ? 'text-white' : 'text-gray-400 dark:text-gray-500'"
      data-testid="entry-lock-icon"
    />

    <slot name="trailing" />
  </div>
</template>
