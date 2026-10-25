<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useEventListener } from '@vueuse/core';
import { currentLocale, lazyStrings } from '@/strings';
import type { GenerationMetrics, GenerationMetricsPresentation } from '@/01-models/generation-metrics';
import { LIVE_SPEED_STALE_MS } from '@/logic/generation-metrics/measurement';
import MessageActionsMenu from './MessageActionsMenu.vue';

const props = defineProps<{ presentation: GenerationMetricsPresentation }>();
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const isOpen = ref(false);
const stale = ref(false);
const panelId = useId();
const numberFormatter = computed(() => new Intl.NumberFormat(currentLocale.value, { maximumFractionDigits: 1 }));
const preciseFormatter = computed(() => new Intl.NumberFormat(currentLocale.value, { maximumSignificantDigits: 3 }));
const countFormatter = computed(() => new Intl.NumberFormat(currentLocale.value));

function formatSpeed({ metrics, live }: { metrics: GenerationMetrics, live: boolean }): string | undefined {
  const value = metrics.speed.perSecond;
  return lazyStrings.GenerationSpeed__rate({ value: (value < 1 ? preciseFormatter.value : numberFormatter.value).format(value), unit: metrics.speed.unit, approximate: live || metrics.speed.measurement === 'received_text' || metrics.speed.measurement === 'client_request' });
}

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  isOpen.value = false;
  if (restoreFocus) {
    trigger.value?.focus();
  }
}

async function toggle(): Promise<void> {
  if (isOpen.value) {
    close({ restoreFocus: true });
    return;
  }
  isOpen.value = true;
  await nextTick();
  panel.value?.focus();
}

useEventListener('keydown', event => {
  if (isOpen.value && event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  }
});

watch([() => props.presentation.runId, () => props.presentation.live, () => props.presentation.updatedAt], ([runId, live, updatedAt], previous, onCleanup) => {
  if (previous[0] !== undefined && previous[0] !== runId) {
    close({ restoreFocus: false });
  }
  stale.value = false;
  if (!live) {
    return;
  }
  const remaining = LIVE_SPEED_STALE_MS - (performance.now() - updatedAt);
  if (remaining <= 0) {
    stale.value = true;
    close({ restoreFocus: false });
    return;
  }
  const timer = setTimeout(() => {
    stale.value = true;
    close({ restoreFocus: false });
  }, remaining);
  onCleanup(() => clearTimeout(timer));
}, { immediate: true });

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <span v-if="!stale" class="generation-speed" tw-class="text-gray-500 dark:text-gray-400" data-testid="generation-speed">
    <button
      ref="trigger"
      type="button"
      class="generation-speed-trigger"
      :aria-label="`${lazyStrings.GenerationSpeed__generation_details() ?? ''}: ${formatSpeed({ metrics: presentation.metrics, live: presentation.live }) ?? ''}`"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? panelId : undefined"
      aria-haspopup="dialog"
      @click="toggle"
      data-testid="generation-speed-trigger"
    >{{ formatSpeed({ metrics: presentation.metrics, live: presentation.live }) }}</button>
    <MessageActionsMenu :is-open="isOpen" :trigger-el="trigger" :width="320" @close="close({ restoreFocus: false })">
      <section :id="panelId" ref="panel" tabindex="-1" role="dialog" :aria-label="lazyStrings.GenerationSpeed__generation_details()" tw-class="p-3 text-xs text-gray-700 dark:text-gray-200 outline-none" data-testid="generation-speed-details">
        <h3 tw-class="font-semibold mb-2">{{ lazyStrings.GenerationSpeed__generation_details() }}</h3>
        <p tw-class="mb-2 text-gray-500 dark:text-gray-400">{{ lazyStrings.GenerationSpeed__scope({ scope: presentation.scope, live: presentation.live, nCalls: presentation.calls.length }) }}</p>
        <dl class="generation-speed-values">
          <dt>{{ lazyStrings.GenerationSpeed__speed() }}</dt>
          <dd>{{ formatSpeed({ metrics: presentation.metrics, live: presentation.live }) }}</dd>
          <template v-if="presentation.metrics.nOutputTokens !== undefined">
            <dt>{{ lazyStrings.GenerationSpeed__output_tokens() }}</dt>
            <dd>{{ countFormatter.format(presentation.metrics.nOutputTokens) }}</dd>
          </template>
          <template v-if="presentation.metrics.nInputTokens !== undefined">
            <dt>{{ lazyStrings.GenerationSpeed__input_tokens() }}</dt>
            <dd>{{ countFormatter.format(presentation.metrics.nInputTokens) }}</dd>
          </template>
          <template v-if="presentation.metrics.speed.interval !== undefined">
            <dt>{{ lazyStrings.GenerationSpeed__measured_units({ unit: presentation.metrics.speed.unit }) }}</dt>
            <dd>{{ countFormatter.format(presentation.metrics.speed.interval.nUnits) }}</dd>
            <dt>{{ lazyStrings.GenerationSpeed__measurement_interval() }}</dt>
            <dd>{{ lazyStrings.GenerationSpeed__seconds({ value: preciseFormatter.format(presentation.metrics.speed.interval.durationMs / 1000) }) }}</dd>
          </template>
        </dl>
        <p tw-class="mt-3 text-gray-500 dark:text-gray-400 leading-relaxed">{{ lazyStrings.GenerationSpeed__measurement_description({ measurement: presentation.metrics.speed.measurement }) }}</p>
        <div v-if="presentation.calls.length > 1" tw-class="mt-3 border-t border-gray-100 dark:border-gray-700 pt-2">
          <div v-for="(call, index) in presentation.calls" :key="index" tw-class="mb-2">
            <div tw-class="flex justify-between gap-2">
              <span>{{ lazyStrings.GenerationSpeed__generation_number({ n: index + 1 + (presentation.nOmittedCalls ?? 0) }) }}</span>
              <span>{{ call.metrics === undefined ? lazyStrings.GenerationSpeed__not_measured() : formatSpeed({ metrics: call.metrics, live: presentation.live && index === presentation.calls.length - 1 }) }}</span>
            </div>
            <p v-if="call.metrics !== undefined" tw-class="text-gray-500 dark:text-gray-400 mt-1">{{ lazyStrings.GenerationSpeed__measurement_description({ measurement: call.metrics.speed.measurement }) }}</p>
          </div>
        </div>
      </section>
    </MessageActionsMenu>
  </span>
</template>

<style scoped>
.generation-speed {
  display: inline-flex;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.generation-speed-trigger {
  min-height: 28px;
  padding: 4px 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
  cursor: pointer;
}
.generation-speed-trigger:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
  border-radius: 3px;
}
.generation-speed-values {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 12px;
}
.generation-speed-values dd {
  text-align: right;
}
</style>
