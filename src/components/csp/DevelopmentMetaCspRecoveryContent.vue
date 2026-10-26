<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import { FlaskConicalIcon, XIcon } from 'lucide-vue-next';
import { useDevelopmentMetaCspNotForSecurity } from '@/composables/useDevelopmentMetaCspNotForSecurity';
import { useSettings } from '@/composables/useSettings';
import { ensureStrings } from '@/strings';

const development = useDevelopmentMetaCspNotForSecurity();
const { initialized } = useSettings();
// Keep the actual persistence callback resident before any meta is appended.
const clearSavedValue = development.clearDevelopmentMetaCspNotForSecurity;
const clearButton = useTemplateRef<HTMLButtonElement>('clear-button');
const labels = shallowRef<Readonly<{ title: string, warning: string, close: string, clear: string, clearing: string, failed: string, changed: string, cleared: string }>>();
const everNeeded = ref(false);
const noticeVisibility = ref<'visible' | 'dismissed'>('visible');
const clearing = ref(false);
const localFailure = ref(false);
let disposed = false;

const busy = computed(() => {
  const operation = development.operation.value;
  switch (operation) {
  case 'saving': return true;
  case 'idle':
  case 'saved':
  case 'failed':
  case 'changed': return false;
  default: {
    const exhaustive: never = operation;
    return exhaustive;
  }
  }
});
watch(() => development.savedSerialized.value !== undefined || development.snapshot.value.additions.length > 0, needed => {
  // Clearing a setting does not revoke policies already added to this page.
  if (needed) {
    everNeeded.value = true;
  }
}, { immediate: true, flush: 'sync' });
watch([development.savedSerialized, () => development.snapshot.value.additions], () => {
  // Dismissal lasts until a different saved or actually added policy needs attention.
  noticeVisibility.value = 'visible';
}, { flush: 'sync' });

function isRecoveryResident(): boolean {
  try {
    return !disposed && initialized.value && labels.value !== undefined && typeof clearSavedValue === 'function'
      && clearButton.value?.isConnected === true;
  } catch {
    return false;
  }
}

watch([labels, clearButton, busy, clearing, initialized], () => {
  const noPolicyYet = development.savedSerialized.value === undefined && development.snapshot.value.additions.length === 0;
  if (!busy.value && !clearing.value && initialized.value && labels.value !== undefined && (noPolicyYet || isRecoveryResident())) {
    // Register even before the first setting exists. The adapter waits for the
    // next DOM flush when its first save creates a connected clear button.
    void development.prepareResidentRecoveryAndApplySavedMetaForDevelopmentNotForSecurity({ isRecoveryResident }).catch(() => {
      // Failure to prepare skips meta; it must not affect the ordinary app.
    });
  }
}, { flush: 'post' });

async function clearSetting(): Promise<void> {
  if (clearing.value || busy.value) {
    return;
  }
  clearing.value = true;
  localFailure.value = false;
  try {
    await clearSavedValue();
  } catch {
    localFailure.value = true;
  } finally {
    clearing.value = false;
  }
}

onMounted(() => {
  void (async () => {
    try {
      // Store resolved labels, not lazy accessors. A stricter script policy or
      // later locale change cannot require another pack to clear the setting.
      const resident = Object.freeze({
        title: await ensureStrings.DevelopmentMetaCspRecovery__development_meta_csp(),
        warning: await ensureStrings.DevelopmentMetaCspRecovery__development_only_never_for_security(),
        close: await ensureStrings.DevelopmentMetaCspRecovery__close_notice(),
        clear: await ensureStrings.DevelopmentMetaCspRecovery__clear_saved_meta_csp_setting(),
        clearing: await ensureStrings.DevelopmentMetaCspRecovery__clearing_saved_meta_csp(),
        failed: await ensureStrings.DevelopmentMetaCspRecovery__could_not_clear_saved_setting(),
        changed: await ensureStrings.DevelopmentMetaCspRecovery__storage_changed_try_again(),
        cleared: await ensureStrings.DevelopmentMetaCspRecovery__setting_cleared_current_meta_remains(),
      });
      if (!disposed) {
        labels.value = resident;
      }
    } catch {
      // No labels means no resident button and therefore no saved-meta apply.
    }
  })();
});
onBeforeUnmount(() => {
  disposed = true;
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- Keep the prepared controls resident when dismissed; hiding never changes saved or enforced CSP. -->
  <aside v-if="labels !== undefined && everNeeded" v-show="noticeVisibility === 'visible'" role="note" data-testid="development-meta-csp-recovery" :aria-label="`${labels.title}: ${labels.warning}`" tw-class="fixed inset-x-3 bottom-3 z-[12000] max-w-full space-y-1.5 rounded-lg border border-gray-200/80 bg-white px-3 py-2 text-xs leading-relaxed text-gray-600 dark:border-gray-700/70 dark:bg-gray-900 dark:text-gray-300 sm:left-auto print:hidden">
    <div tw-class="flex flex-wrap items-center gap-x-3 gap-y-1.5"><p tw-class="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200"><FlaskConicalIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400" />{{ labels.title }}</p><span tw-class="text-gray-400 dark:text-gray-500">{{ labels.warning }}</span><button ref="clear-button" type="button" :disabled="clearing || busy" data-testid="development-meta-csp-clear" tw-class="inline-flex min-h-7 items-center justify-center rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-wait disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800/45 dark:text-gray-200 dark:hover:bg-gray-800 motion-reduce:transition-none" @click="clearSetting">{{ clearing ? labels.clearing : labels.clear }}</button><button type="button" :aria-label="labels.close" :title="labels.close" data-testid="development-meta-csp-dismiss" tw-class="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:hover:bg-gray-800 dark:hover:text-gray-200 motion-reduce:transition-none" @click="noticeVisibility = 'dismissed'"><XIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button></div>
    <p v-if="development.savedSerialized.value === undefined && development.snapshot.value.additions.length > 0" data-testid="development-meta-csp-setting-cleared">{{ labels.cleared }}</p>
    <p v-if="localFailure || development.operation.value === 'failed'" role="status" data-testid="development-meta-csp-recovery-failure">{{ labels.failed }}</p>
    <p v-else-if="development.operation.value === 'changed'" role="status" data-testid="development-meta-csp-recovery-changed">{{ labels.changed }}</p>
  </aside>
</template>
