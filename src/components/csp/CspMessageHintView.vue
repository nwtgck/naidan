<script setup lang="ts">
import { inject, ref, useId, useTemplateRef, watch, type Ref } from 'vue';
import { ChevronDownIcon, InfoIcon } from 'lucide-vue-next';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
import CspHintDetails from './CspHintDetails.vue';
import CspDeploymentGuidance from './CspDeploymentGuidance.vue';
import type { CspHintDisplayCopy } from './hint-copy';

defineOptions({ name: 'CspMessageHintView' });
const props = defineProps<{ copy: CspHintDisplayCopy, presentation: 'compact' | 'error' | 'error-details' }>();
const triggerRef = useTemplateRef<HTMLButtonElement>('trigger');
const panelId = useId();
const expanded = ref(false);
const visited = ref(false);
const failed = ref(false);
const disclosureOpen = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);

function safely({ action }: { action: () => void }): void {
  try {
    action();
  } catch {
    // Optional disclosure events must not escape into the feature's controls.
    expanded.value = false;
    failed.value = true;
  }
}

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  expanded.value = false;
  if (restoreFocus) {
    triggerRef.value?.focus({ preventScroll: true });
  }
}

function toggle(): void {
  safely({
    action: () => {
      if (disclosureOpen?.value === false) {
        return;
      }
      if (expanded.value) {
        close({ restoreFocus: false });
        return;
      }
      visited.value = true;
      expanded.value = true;
    },
  });
}

function handleKeydown({ event }: { event: KeyboardEvent }): void {
  safely({
    action: () => {
      if (!expanded.value || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
        return;
      }
    },
  });
}

watch(() => disclosureOpen?.value, open => safely({
  action: () => {
    if (open === false && expanded.value) {
      close({ restoreFocus: false });
    }
  },
}), { flush: 'sync' });
watch(() => props.copy, () => safely({
  action: () => {
    if (expanded.value) {
      close({ restoreFocus: false });
    }
  },
}));


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
  <aside v-if="!failed" role="note" data-testid="csp-message-hint" :tw-class="['w-full min-w-0 max-w-full', presentation !== 'compact' ? 'text-blue-600 dark:text-blue-400' : 'text-amber-800 dark:text-amber-200']" @keydown="handleKeydown({ event: $event })">
    <button v-if="presentation !== 'error-details'" ref="trigger" type="button" data-testid="csp-hint-trigger" :aria-expanded="expanded" :aria-controls="expanded ? panelId : undefined" :tw-class="['-mx-1 inline-flex max-w-full items-start gap-1 rounded-md px-1 py-0.5 text-left text-xs leading-4 outline-none transition-colors duration-150 focus-visible:ring-2 motion-reduce:transition-none', presentation !== 'compact' ? 'hover:bg-blue-500/10 hover:text-blue-700 focus-visible:ring-blue-500/40 dark:hover:text-blue-300' : 'hover:bg-amber-500/10 hover:text-amber-900 focus-visible:ring-amber-500/40 dark:hover:text-amber-100']" @click="toggle">
      <InfoIcon aria-hidden="true" :tw-class="['mt-0.5 h-3.5 w-3.5 shrink-0', presentation !== 'compact' ? 'text-blue-600 dark:text-blue-400' : 'text-amber-600 dark:text-amber-400']" />
      <span tw-class="min-w-0 break-keep break-words">{{ presentation !== 'compact' ? copy.errorSummary : copy.summary }}</span>
      <ChevronDownIcon aria-hidden="true" :tw-class="['mt-0.5 h-3 w-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none', expanded ? 'rotate-180' : '']" />
    </button>
    <SettingsCollapse :id="panelId" :open="presentation === 'error-details' || expanded" :return-focus="triggerRef ?? undefined">
      <div v-if="presentation === 'error-details' || visited" tw-class="space-y-3 pb-1 pt-2 text-xs leading-relaxed" data-testid="csp-hint-inline-details">
        <section data-testid="csp-warning-zone" :tw-class="['space-y-2 rounded-lg p-3', presentation !== 'compact' ? 'bg-blue-50/80 text-blue-900 dark:bg-blue-500/10 dark:text-blue-200' : 'bg-amber-50/80 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200']">
          <p tw-class="font-medium">{{ copy.title }}</p>
          <CspHintDetails :rows="copy.rows" :policy-note="copy.policyNote" technical-details="collapsed" :technical-details-label="copy.technicalDetailsLabel"><div tw-class="space-y-1.5"><p data-testid="csp-destination-explanation" tw-class="break-words">{{ copy.explanation }}</p><p v-if="presentation !== 'compact'" data-testid="csp-error-note" tw-class="text-xs leading-relaxed opacity-80">{{ copy.errorNote }}</p></div></CspHintDetails>
        </section>
        <CspDeploymentGuidance v-if="copy.suggestedDeployments.length > 0" :deployments="copy.suggestedDeployments" />
      </div>
    </SettingsCollapse>
  </aside>
</template>
