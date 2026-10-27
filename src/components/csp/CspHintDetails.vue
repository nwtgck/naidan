<script setup lang="ts">
import { ref, useId, useTemplateRef } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
import type { CspHintDisplayRow } from './hint-copy';

defineOptions({ name: 'CspHintDetails' });
defineProps<{
  rows: readonly CspHintDisplayRow[],
  policyNote: string | undefined,
  technicalDetails: 'expanded' | 'collapsed',
  technicalDetailsLabel: string | undefined,
}>();
const technicalOpen = ref(false);
const technicalVisited = ref(false);
const technicalId = useId();
const technicalTrigger = useTemplateRef<HTMLButtonElement>('technical-trigger');

function toggleTechnical(): void {
  technicalVisited.value = true;
  technicalOpen.value = !technicalOpen.value;
}


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
  <div tw-class="space-y-2">
    <p v-if="policyNote !== undefined" tw-class="text-xs leading-relaxed">{{ policyNote }}</p>
    <div v-for="(row, index) in rows" :key="index" tw-class="space-y-1.5">
      <p v-if="technicalDetails === 'expanded'" tw-class="text-xs font-medium">{{ row.context }} <code tw-class="font-mono text-xs opacity-80">{{ row.directive }}</code></p>
      <ul tw-class="list-disc space-y-0.5 pl-4 text-xs leading-relaxed">
        <li v-for="(source, sourceIndex) in row.sourceLabels" :key="sourceIndex" tw-class="break-all">{{ source }}</li>
      </ul>
      <code v-if="technicalDetails === 'expanded'" tw-class="block break-all rounded-lg border border-current/15 bg-white/40 px-2 py-1.5 font-mono text-xs leading-relaxed dark:bg-gray-950/30">{{ row.directive }} {{ row.serializedSources }}</code>
    </div>
    <slot />
    <div v-if="technicalDetails === 'collapsed'" tw-class="border-t border-current/10 pt-1">
      <button ref="technical-trigger" type="button" :aria-expanded="technicalOpen" :aria-controls="technicalOpen ? technicalId : undefined" data-testid="csp-technical-trigger" tw-class="flex min-h-8 w-full items-center justify-between gap-2 rounded text-left text-xs font-medium leading-relaxed opacity-75 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40 motion-reduce:transition-none" @click="toggleTechnical"><span>{{ technicalDetailsLabel }}</span><ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none', technicalOpen ? 'rotate-180' : '']" /></button>
      <SettingsCollapse :id="technicalId" :open="technicalOpen" :return-focus="technicalTrigger ?? undefined">
        <div v-if="technicalVisited" data-testid="csp-technical-details" tw-class="space-y-2 pt-2">
          <div v-for="(row, index) in rows" :key="index" tw-class="space-y-1.5">
            <p tw-class="text-xs font-medium">{{ row.context }} <code tw-class="font-mono text-xs opacity-80">{{ row.directive }}</code></p>
            <code tw-class="block break-all rounded-lg border border-current/15 bg-white/40 px-2 py-1.5 font-mono text-xs leading-relaxed dark:bg-gray-950/30">{{ row.directive }} {{ row.serializedSources }}</code>
          </div>
        </div>
      </SettingsCollapse>
    </div>
  </div>
</template>
