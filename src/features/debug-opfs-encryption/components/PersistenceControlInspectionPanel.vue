<script setup lang="ts">
import { computed } from 'vue';
import { ShieldAlertIcon, ShieldCheckIcon } from 'lucide-vue-next';
import type { PersistenceControlInspection } from '@/00-storage/service/naidan-persistence-control/inspection/persistence-control-inspection-types';
import { createPersistenceControlInspectionView } from '@/features/debug-opfs-encryption/logic/persistence-control-inspection-view';

const props = defineProps<{
  inspection: PersistenceControlInspection;
}>();

const view = computed(() => createPersistenceControlInspectionView({ inspection: props.inspection }));

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <section data-testid="persistence-control-inspection" tw-class="border-b border-gray-200 dark:border-gray-700">
    <header tw-class="flex flex-wrap items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
      <div tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
        <ShieldCheckIcon v-if="inspection.selection.state === 'selected'" tw-class="h-4 w-4" />
        <ShieldAlertIcon v-else tw-class="h-4 w-4" />
      </div>
      <div tw-class="min-w-0 flex-1">
        <h2 tw-class="text-xs font-semibold text-gray-800 dark:text-gray-100">Naidan Persistence Control</h2>
        <p data-testid="persistence-control-selection" tw-class="mt-0.5 break-all font-mono text-[11px] text-gray-500 dark:text-gray-400">{{ view.selectionSummary }}</p>
      </div>
      <div tw-class="font-mono text-[10px] text-gray-500 dark:text-gray-400">
        observed: {{ view.observedSequences[0] }} / {{ view.observedSequences[1] }}
      </div>
    </header>

    <div tw-class="grid gap-3 p-4 lg:grid-cols-2">
      <article
        v-for="row in view.copyRows"
        :key="row.copy"
        :data-testid="`persistence-control-copy-${row.copy}`"
        tw-class="min-w-0 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950"
      >
        <div tw-class="flex items-center gap-2">
          <span tw-class="font-mono text-xs font-semibold text-gray-800 dark:text-gray-100">copy {{ row.copy }}</span>
          <span v-if="row.selected" tw-class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">selected</span>
          <span tw-class="ml-auto break-all font-mono text-[10px] text-gray-500 dark:text-gray-400">{{ row.state }}</span>
        </div>
        <dl tw-class="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
          <dt tw-class="text-gray-400">Path</dt><dd tw-class="break-all font-mono text-gray-700 dark:text-gray-200">{{ row.physicalPath }}</dd>
          <dt tw-class="text-gray-400">Sequence</dt><dd tw-class="font-mono text-gray-700 dark:text-gray-200">{{ row.sequence }}</dd>
          <dt tw-class="text-gray-400">Protection</dt><dd tw-class="break-all font-mono text-gray-700 dark:text-gray-200">{{ row.protection ?? 'unavailable' }}</dd>
          <dt tw-class="text-gray-400">Mode</dt><dd tw-class="break-all font-mono text-gray-700 dark:text-gray-200">{{ row.modeSummary }}</dd>
          <dt tw-class="text-gray-400">Persisted control DTO</dt><dd><pre :data-testid="`persistence-control-control-dto-${row.copy}`" tw-class="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-700 dark:text-gray-200">{{ row.controlJson }}</pre></dd>
          <dt tw-class="text-gray-400">Mode DTO</dt><dd><pre :data-testid="`persistence-control-mode-dto-${row.copy}`" tw-class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-gray-700 dark:text-gray-200">{{ row.modeJson }}</pre></dd>
          <dt tw-class="text-gray-400">Authentication FS</dt><dd tw-class="break-all font-mono text-gray-700 dark:text-gray-200">{{ row.authenticationFileSystemId ?? 'unavailable' }}</dd>
          <dt tw-class="text-gray-400">Retired FS</dt><dd tw-class="break-all font-mono text-gray-700 dark:text-gray-200">{{ row.retiredFileSystemIds.length === 0 ? 'none' : row.retiredFileSystemIds.join(', ') }}</dd>
          <template v-if="row.reason !== undefined">
            <dt tw-class="text-gray-400">Reason</dt><dd tw-class="break-words font-mono text-red-700 dark:text-red-300">{{ row.reason }}</dd>
          </template>
        </dl>
      </article>
    </div>
  </section>
</template>
