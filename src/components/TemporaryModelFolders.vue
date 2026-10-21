<script setup lang="ts">
import { onScopeDispose, shallowRef } from 'vue';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { lazyStrings } from '@/strings';
const props = defineProps<{ disabled: boolean }>();
const roots = shallowRef(temporaryModelFiles.list());
onScopeDispose(temporaryModelFiles.subscribe({
  listener: () => {
    roots.value = temporaryModelFiles.list();
  },
}));

function unregister({ rootId }: { rootId: string }): void {
  if (!props.disabled) {
    temporaryModelFiles.remove({ rootId });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="roots.length" data-testid="temporary-model-folders" tw-class="space-y-2 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
    <h4 tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.TemporaryModelFolders__title() }}</h4>
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.TemporaryModelFolders__help() }}</p>
    <ul tw-class="divide-y divide-gray-100 dark:divide-gray-800">
      <li v-for="root in roots" :key="root.id" tw-class="flex flex-wrap items-center gap-3 py-2 text-xs">
        <code tw-class="min-w-0 flex-1 break-all">{{ root.id }}</code>
        <button type="button" :disabled="disabled" :data-testid="'unregister-' + root.id" @click="unregister({ rootId: root.id })" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-gray-600 dark:text-gray-300 disabled:opacity-50">{{ lazyStrings.TemporaryModelFolders__unregister() }}</button>
      </li>
    </ul>
  </div>
</template>
