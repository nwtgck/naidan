<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useEventListener } from '@vueuse/core';
import { GaugeIcon, InfoIcon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import type { GenerationMetrics, GenerationMetricsPresentation } from '@/01-models/generation-metrics';
import { LIVE_SPEED_STALE_MS } from '@/logic/generation-metrics/measurement';
import { useGenerationSpeedSettings } from '@/composables/useGenerationSpeedSettings';
import MessageActionsMenu from './MessageActionsMenu.vue';
import SettingsChoiceControl from './SettingsChoiceControl.vue';
import GenerationSpeedServerSettings from './GenerationSpeedServerSettings.vue';

const props = defineProps<{ presentation: GenerationMetricsPresentation }>();
const trigger = ref<HTMLButtonElement | null>(null);
const detailsTrigger = ref<HTMLButtonElement | null>(null);
const panelOpener = ref<HTMLElement>();
const panel = ref<HTMLElement | null>(null);
const inlineExpanded = ref(false);
const isOpen = ref(false);
const stale = ref(false);
const panelId = useId();
const inlineId = useId();
const { status, inlineStats, saving, update: updateGenerationSpeedSettings } = useGenerationSpeedSettings();
const alwaysShowInlineStats = computed(() => {
  const mode = inlineStats.value;
  switch (mode) {
  case 'always': return true;
  case 'on_demand': return false;
  default: {
    const exhaustive: never = mode;
    throw new Error(`Unhandled inline statistics mode: ${exhaustive}`);
  }
  }
});
const showInlineStats = computed(() => alwaysShowInlineStats.value || inlineExpanded.value);
const numberFormatter = computed(() => new Intl.NumberFormat(currentLocale.value, { maximumFractionDigits: 1 }));
const preciseFormatter = computed(() => new Intl.NumberFormat(currentLocale.value, { maximumSignificantDigits: 3 }));
const countFormatter = computed(() => new Intl.NumberFormat(currentLocale.value));

function formatSpeed({ metrics }: { metrics: GenerationMetrics }): string | undefined {
  const value = metrics.speed.perSecond;
  return lazyStrings.GenerationSpeed__rate({ value: (value < 1 ? preciseFormatter.value : numberFormatter.value).format(value), unit: metrics.speed.unit, approximate: false });
}

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  isOpen.value = false;
  if (restoreFocus) {
    panelOpener.value?.focus();
  }
}

async function toggleDetails({ opener }: { opener: HTMLElement | undefined }): Promise<void> {
  if (isOpen.value) {
    close({ restoreFocus: true });
    return;
  }
  panelOpener.value = opener;
  isOpen.value = true;
  await nextTick();
  panel.value?.focus();
}

async function toggleInlineStats(): Promise<void> {
  if (alwaysShowInlineStats.value) {
    await toggleDetails({ opener: trigger.value ?? undefined });
    return;
  }
  inlineExpanded.value = !inlineExpanded.value;
  if (!inlineExpanded.value) {
    close({ restoreFocus: false });
  }
}

const triggerLabel = computed(() => {
  const label = alwaysShowInlineStats.value
    ? lazyStrings.GenerationSpeed__generation_details()
    : lazyStrings.GenerationSpeed__token_count_and_measurement_interval();
  const speed = formatSpeed({ metrics: props.presentation.metrics });
  return label === undefined || speed === undefined ? undefined : `${speed} · ${label}`;
});

watch(inlineStats, () => {
  if (isOpen.value) {
    inlineExpanded.value = true;
  }
});

watch(status, value => {
  switch (value) {
  case 'enabled': return;
  case 'disabled':
    close({ restoreFocus: false });
    inlineExpanded.value = false;
    return;
  default: {
    const exhaustive: never = value;
    throw new Error(`Unhandled generation speed visibility: ${exhaustive}`);
  }
  }
});

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
    inlineExpanded.value = false;
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
  <span v-if="status === 'enabled' && !stale" class="generation-speed" tw-class="items-center gap-1 text-gray-500 dark:text-gray-400" data-testid="generation-speed">
    <span v-if="showInlineStats" :id="inlineId" tw-class="inline-flex items-center gap-2 whitespace-nowrap text-[11px] text-gray-400 dark:text-gray-500" data-testid="generation-speed-inline-stats">
      <span :title="lazyStrings.GenerationSpeed__output_tokens()">{{ lazyStrings.GenerationSpeed__output_token_count({ value: presentation.metrics.nOutputTokens === undefined ? '—' : countFormatter.format(presentation.metrics.nOutputTokens) }) }}</span>
      <span aria-hidden="true" tw-class="text-gray-300 dark:text-gray-600">·</span>
      <span :title="lazyStrings.GenerationSpeed__measurement_interval()">{{ lazyStrings.GenerationSpeed__measured_interval({ value: presentation.metrics.speed.interval === undefined ? '—' : preciseFormatter.format(presentation.metrics.speed.interval.durationMs / 1000) }) }}</span>
    </span>
    <button
      ref="trigger"
      type="button"
      class="generation-speed-trigger"
      :aria-label="triggerLabel"
      :aria-expanded="alwaysShowInlineStats ? isOpen : showInlineStats"
      :aria-controls="alwaysShowInlineStats ? (isOpen ? panelId : undefined) : (showInlineStats ? inlineId : undefined)"
      :aria-haspopup="alwaysShowInlineStats ? 'dialog' : undefined"
      @click="toggleInlineStats"
      data-testid="generation-speed-trigger"
    >{{ formatSpeed({ metrics: presentation.metrics }) }}</button>
    <button
      v-if="showInlineStats"
      ref="detailsTrigger"
      type="button"
      :aria-label="lazyStrings.GenerationSpeed__generation_details()"
      :title="lazyStrings.GenerationSpeed__generation_details()"
      :aria-expanded="isOpen"
      :aria-controls="isOpen ? panelId : undefined"
      aria-haspopup="dialog"
      tw-class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-blue-400"
      data-testid="generation-speed-details-trigger"
      @click="toggleDetails({ opener: detailsTrigger ?? undefined })"
    ><InfoIcon tw-class="h-3.5 w-3.5" /></button>
    <MessageActionsMenu :is-open="isOpen" :trigger-el="detailsTrigger" :additional-trigger-els="trigger ? [trigger] : []" :width="344" @close="close({ restoreFocus: false })">
      <section :id="panelId" ref="panel" tabindex="-1" role="dialog" :aria-label="lazyStrings.GenerationSpeed__generation_details()" tw-class="text-xs tabular-nums text-gray-700 outline-none dark:text-gray-200" data-testid="generation-speed-details">
        <div tw-class="px-4 pb-4 pt-3">
          <div tw-class="mb-4 flex items-center gap-3">
            <span tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-gray-50 text-blue-500 dark:border-gray-700 dark:bg-gray-900/50 dark:text-blue-400"><GaugeIcon tw-class="h-4 w-4" /></span>
            <div tw-class="min-w-0">
              <h3 tw-class="text-sm font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.GenerationSpeed__generation_details() }}</h3>
              <p tw-class="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__scope({ scope: presentation.scope, live: presentation.live, nCalls: presentation.calls.length }) }}</p>
            </div>
          </div>
          <div tw-class="mb-3 rounded-xl border border-blue-100/70 bg-blue-50/60 px-3 py-3 dark:border-blue-900/40 dark:bg-blue-950/20">
            <p tw-class="mb-1 text-[10px] font-medium text-blue-500 dark:text-blue-400">{{ lazyStrings.GenerationSpeed__speed() }}</p>
            <p tw-class="text-xl font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ formatSpeed({ metrics: presentation.metrics }) }}</p>
          </div>
          <dl tw-class="grid grid-cols-2 gap-2">
            <div v-if="presentation.metrics.nOutputTokens !== undefined" tw-class="rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-gray-900/50">
              <dt tw-class="text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__output_tokens() }}</dt>
              <dd tw-class="mt-1 text-sm font-semibold text-gray-700 dark:text-gray-200">{{ countFormatter.format(presentation.metrics.nOutputTokens) }}</dd>
            </div>
            <div v-if="presentation.metrics.nInputTokens !== undefined" tw-class="rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-gray-900/50">
              <dt tw-class="text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__input_tokens() }}</dt>
              <dd tw-class="mt-1 text-sm font-semibold text-gray-700 dark:text-gray-200">{{ countFormatter.format(presentation.metrics.nInputTokens) }}</dd>
            </div>
            <template v-if="presentation.metrics.speed.interval !== undefined">
              <div tw-class="rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-gray-900/50">
                <dt tw-class="text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__measurement_interval() }}</dt>
                <dd tw-class="mt-1 text-sm font-semibold text-gray-700 dark:text-gray-200">{{ lazyStrings.GenerationSpeed__seconds({ value: preciseFormatter.format(presentation.metrics.speed.interval.durationMs / 1000) }) }}</dd>
              </div>
              <div tw-class="rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-gray-900/50">
                <dt tw-class="text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__measured_units({ unit: presentation.metrics.speed.unit }) }}</dt>
                <dd tw-class="mt-1 text-sm font-semibold text-gray-700 dark:text-gray-200">{{ countFormatter.format(presentation.metrics.speed.interval.nUnits) }}</dd>
              </div>
            </template>
          </dl>
          <p tw-class="mt-3 text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__measurement_description({ measurement: presentation.metrics.speed.measurement }) }}</p>
          <div v-if="presentation.calls.length > 1" tw-class="mt-4 space-y-3 border-t border-gray-100 pt-3 dark:border-gray-700">
            <div v-for="(call, index) in presentation.calls" :key="index">
              <div tw-class="flex justify-between gap-2 text-[11px] font-medium">
                <span>{{ lazyStrings.GenerationSpeed__generation_number({ n: index + 1 + (presentation.nOmittedCalls ?? 0) }) }}</span>
                <span>{{ call.metrics === undefined ? lazyStrings.GenerationSpeed__not_measured() : formatSpeed({ metrics: call.metrics }) }}</span>
              </div>
              <p v-if="call.snapshot === 'last_sample'" tw-class="mt-1 text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__scope({ scope: 'last_sample', live: false, nCalls: 1 }) }}</p>
              <p v-if="call.metrics !== undefined" tw-class="mt-1 text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__measurement_description({ measurement: call.metrics.speed.measurement }) }}</p>
            </div>
          </div>
        </div>
        <div tw-class="space-y-3 border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <GenerationSpeedServerSettings />
          <label tw-class="flex cursor-pointer items-center justify-between gap-4 text-[11px] font-medium">
            <span>{{ lazyStrings.GenerationSpeed__always_show_token_count_and_interval() }}</span>
            <SettingsChoiceControl presentation="switch"><input type="checkbox" :checked="inlineStats === 'always'" :disabled="saving" data-testid="generation-speed-always-show-toggle" @change="updateGenerationSpeedSettings({ patch: { inlineStats: ($event.target as HTMLInputElement).checked ? 'always' : 'on_demand' } })" /></SettingsChoiceControl>
          </label>
          <div>
            <label tw-class="flex cursor-pointer items-center justify-between gap-4 text-[11px] font-medium">
              <span>{{ lazyStrings.GenerationSpeed__show_generation_speed() }}</span>
              <SettingsChoiceControl presentation="switch"><input type="checkbox" :checked="status === 'enabled'" :disabled="saving" data-testid="generation-speed-visible-toggle" @change="updateGenerationSpeedSettings({ patch: { status: ($event.target as HTMLInputElement).checked ? 'enabled' : 'disabled' } })" /></SettingsChoiceControl>
            </label>
            <p tw-class="mt-2 text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.GenerationSpeed__enable_again_in_developer_settings() }}</p>
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
</style>
