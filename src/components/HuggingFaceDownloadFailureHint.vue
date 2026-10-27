<script setup lang="ts">
import { computed, inject, ref, useId, useTemplateRef, watch, type Ref } from 'vue';
import { ChevronDownIcon, InfoIcon } from 'lucide-vue-next';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import { lazyStrings } from '@/strings';

// Supply the feature's existing recovery UI through the default slot. This
// disclosure neither owns model operations nor depends on CSP availability.
const expanded = ref(false);
const visited = ref(false);
const trigger = useTemplateRef<HTMLButtonElement>('trigger');
const panelId = useId();
const parentOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const label = computed(() => {
  try {
    return lazyStrings.HuggingFaceDownloadFailureHint__hints_for_resolving_this_error();
  } catch {
    return undefined;
  }
});

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  expanded.value = false;
  if (restoreFocus) {
    try {
      trigger.value?.focus({ preventScroll: true });
    } catch { /* Focus restoration must not interrupt the original error UI. */ }
  }
}

function toggle(): void {
  if (parentOpen?.value === false) {
    return;
  }
  if (expanded.value) {
    close({ restoreFocus: false });
    return;
  }
  // Defer recovery setup until an explicit open. Keep it inert while closing
  // so the shared transition and in-progress owner actions retain their lifetime.
  visited.value = true;
  expanded.value = true;
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (expanded.value && !event.isComposing && event.keyCode !== 229 && event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  }
}

watch(() => parentOpen?.value, open => {
  if (open === false) {
    close({ restoreFocus: false });
  }
}, { flush: 'sync' });

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="label !== undefined" data-testid="hf-download-failure-hint" tw-class="min-w-0 text-xs" @keydown="keydown({ event: $event })">
    <button ref="trigger" type="button" data-testid="hf-download-failure-trigger" :aria-expanded="expanded" :aria-controls="expanded ? panelId : undefined" tw-class="-mx-1 inline-flex max-w-full items-start gap-1 rounded-md px-1 py-0.5 text-left text-xs leading-4 text-blue-600 outline-none transition-colors duration-150 hover:bg-blue-500/10 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-blue-400 dark:hover:text-blue-300 motion-reduce:transition-none" @click="toggle">
      <InfoIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span tw-class="min-w-0 break-keep break-words">{{ label }}</span>
      <ChevronDownIcon aria-hidden="true" :tw-class="['mt-0.5 h-3 w-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none', expanded ? 'rotate-180' : '']" />
    </button>
    <SettingsCollapse :id="panelId" :open="expanded" :return-focus="trigger ?? undefined">
      <div v-if="visited" data-testid="hf-download-failure-details" tw-class="space-y-3 pb-1 pt-2">
        <CspMessageHint :target="{ kind: 'huggingface-download' }" presentation="error-details" activity-for-display-only="download" />
        <slot />
      </div>
    </SettingsCollapse>
  </div>
</template>
