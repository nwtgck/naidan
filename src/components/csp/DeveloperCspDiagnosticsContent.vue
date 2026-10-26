<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { CheckIcon, ChevronDownIcon, CopyIcon, ShieldIcon, XIcon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import AllowedHtmlView from '@/components/common/AllowedHtmlView.vue';
import { jsonToHighlightedHtml } from '@/logic/security/allowedHtml';
import { useCachedCspParseResultForDeveloperDisplayOnly } from '@/composables/useCspMessageHintsOnly';
import { useDevelopmentMetaCspNotForSecurity } from '@/composables/useDevelopmentMetaCspNotForSecurity';
import type { CspCapturedHeaders, CspObservationSnapshot, CspObservedPolicy } from '@/logic/csp-message-hints/types';
import { lazyStrings } from '@/strings';
import CspHintDetails from './CspHintDetails.vue';
import { describeCspHintRowsForDisplayOnly } from './hint-copy';

const { snapshot } = useCachedCspParseResultForDeveloperDisplayOnly();
const development = useDevelopmentMetaCspNotForSecurity();
const savedMeta = development.savedSerialized;
const savedMetaForDisplay = computed(() => savedMeta.value?.slice(0, 65_536));
const savedMetaWasTruncated = computed(() => savedMeta.value !== undefined && savedMeta.value.length > 65_536);
// Oversized restored settings remain clearable, but are not silently converted
// into a truncated editable value that could later overwrite the saved policy.
const headerDraft = ref(savedMeta.value !== undefined && savedMeta.value.length <= 65_536 ? savedMeta.value : '');
let draftStorageCurrent = development.captureStorageForDevelopmentMetaCspNotForSecurity();
let draftRevision = 0;
let draftDirty = false;
const actionFailed = ref(false);
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
watch(headerDraft, () => {
  draftRevision++;
  draftDirty = true;
}, { flush: 'sync' });
watch(savedMeta, value => {
  if (!draftDirty) {
    headerDraft.value = value !== undefined && value.length <= 65_536 ? value : '';
    draftDirty = false;
    draftStorageCurrent = development.captureStorageForDevelopmentMetaCspNotForSecurity();
  }
});

// These development-meta inputs omit frame-ancestors, which meta does not
// support. Hosted HTTP header policies remain separate; custom input is intact.
const localOnlyPreset = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:* http://127.0.0.1:*; form-action 'none';";
const curatedPreset = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://naidan-curated.pages.dev https://*.naidan-curated.pages.dev; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:* http://127.0.0.1:* https://*.wikipedia.org https://*.wikimedia.org https://huggingface.co https://*.hf.co; frame-src 'self'; child-src 'self'; worker-src 'self' blob:; form-action 'none'; manifest-src 'self'";
const presets = [{ id: 'none', serialized: '' }, { id: 'local-only', serialized: localOnlyPreset }, { id: 'curated', serialized: curatedPreset }] as const;
type PresetId = typeof presets[number]['id'];
const activePreset = computed(() => presets.find(preset => preset.serialized === headerDraft.value)?.id ?? 'custom');
const canSave = computed(() => !busy.value && headerDraft.value.length <= 65_536);

function capturedHeadersForDisplay({ observation }: { observation: CspObservationSnapshot }): CspCapturedHeaders | undefined {
  function complete({ policy }: { policy: CspObservedPolicy | undefined }) {
    if (policy === undefined) {
      return undefined;
    }
    const { serialized, parsed: _parsed, ...rest } = policy;
    rest satisfies Record<PropertyKey, never>;
    return { serialized, originalLength: serialized.length, capture: 'complete' as const };
  }
  switch (observation.kind) {
  case 'observed': return { enforce: complete({ policy: observation.enforce }), reportOnly: complete({ policy: observation.reportOnly }) };
  case 'unavailable': return observation.capturedHeaders;
  case 'not-started':
  case 'pending': return undefined;
  default: {
    const exhaustive: never = observation;
    return exhaustive;
  }
  }
}

const serverHeaders = computed(() => capturedHeadersForDisplay({ observation: snapshot.value.observation }));
const serverSerialized = computed(() => serverHeaders.value?.enforce?.serialized);
const managedMeta = computed(() => {
  const additions = development.snapshot.value.additions;
  let remaining = 65_536;
  const records = [];
  let complete = additions.length <= 8;
  for (const addition of additions.slice(0, 8)) {
    if (remaining === 0) {
      complete = false;
      break;
    }
    const { serialized, policies, source, ...rest } = addition;
    rest satisfies Record<PropertyKey, never>;
    const capturedPolicies: string[] = [];
    const originalPolicyLengths: number[] = [];
    let recordComplete = policies.length <= 16;
    for (const policy of policies.slice(0, 16)) {
      if (remaining === 0) {
        recordComplete = false;
        break;
      }
      const captured = policy.slice(0, remaining);
      remaining -= captured.length;
      capturedPolicies.push(captured);
      originalPolicyLengths.push(policy.length);
      if (captured.length !== policy.length) {
        recordComplete = false;
      }
    }
    const capturedSerialized = serialized.slice(0, remaining);
    remaining -= capturedSerialized.length;
    if (capturedSerialized.length !== serialized.length) {
      recordComplete = false;
    }
    complete &&= recordComplete;
    records.push({ serialized: capturedSerialized, originalLength: serialized.length, policies: capturedPolicies, originalPolicyLengths, originalPolicyCount: policies.length, source, capture: recordComplete ? 'complete' as const : 'truncated' as const });
  }
  return { records, originalCount: additions.length, capture: complete ? 'complete' as const : 'truncated' as const };
});
const connectionRows = computed(() => {
  const details = snapshot.value.connectionSummary;
  if (details === undefined || details.length > 8) {
    return undefined;
  }
  // The initial overview is deliberately small. Full policies remain in the
  // cached headers and explicitly expanded/copied JSON, never a partial list.
  let labelCount = 0;
  for (const detail of details) {
    labelCount += detail.sourceDescriptions.length;
    if (labelCount > 48) {
      return undefined;
    }
  }
  const rows = describeCspHintRowsForDisplayOnly({ details });
  if (rows === undefined) {
    return undefined;
  }
  let outputUnits = 0;
  for (const row of rows) {
    outputUnits += row.context.length + row.directive.length + row.serializedSources.length;
    for (const label of row.sourceLabels) {
      outputUnits += label.length;
    }
    if (outputUnits > 4_096) {
      return undefined;
    }
  }
  return rows;
});
const policyNote = computed(() => (connectionRows.value?.length ?? 0) > 1 ? lazyStrings.CspMessageHint__each_policy_applies_separately() : undefined);

type CopyTarget = 'header' | 'parsed';
const copyStatus = ref<Record<CopyTarget, 'idle' | 'copied' | 'failed'>>({ header: 'idle', parsed: 'idle' });
const parsedExpanded = ref(false);
const copyingJson = ref(false);
const parsedJson = computed(() => {
  if (!parsedExpanded.value && !copyingJson.value) {
    return undefined;
  }
  try {
    const parsed = snapshot.value.addedMetaParsed;
    return JSON.stringify({
      observed: snapshot.value.observation,
      managedMeta: { ...managedMeta.value, diagnostics: development.snapshot.value.diagnostics, parsed: parsed?.slice(0, 8), parsedOriginalCount: parsed?.length, parsedCapture: parsed === undefined ? 'unavailable' : parsed.length > 8 ? 'truncated' : 'complete' },
      privacyFetch: development.snapshot.value.privacyBroker,
      savedDevelopmentMeta: savedMeta.value === undefined ? undefined : { serialized: savedMetaForDisplay.value, originalLength: savedMeta.value.length, capture: savedMetaWasTruncated.value ? 'truncated' : 'complete' },
    }, undefined, 2);
  } catch {
    return undefined;
  }
});
const parsedHtml = computed(() => {
  if (!parsedExpanded.value) {
    return undefined;
  }
  try {
    const json = parsedJson.value;
    return json === undefined ? undefined : jsonToHighlightedHtml({ json, highlight: true, keyStyle: 'raw' });
  } catch {
    return undefined;
  }
});
const labels = computed(() => {
  try {
    const result = {
      title: lazyStrings.DeveloperCspDiagnostics__content_security_policy(),
      description: lazyStrings.DeveloperCspDiagnostics__inspect_http_and_managed_meta(),
      setting: lazyStrings.DeveloperCspDiagnostics__development_meta_csp(),
      value: lazyStrings.DeveloperCspDiagnostics__meta_csp_setting_value(),
      none: lazyStrings.DeveloperCspDiagnostics__none(),
      localOnly: lazyStrings.DeveloperCspDiagnostics__local_only(),
      curated: lazyStrings.DeveloperCspDiagnostics__curated(),
      custom: lazyStrings.DeveloperCspDiagnostics__custom(),
      save: lazyStrings.DeveloperCspDiagnostics__save_and_add_meta_csp(),
      clear: lazyStrings.DeveloperCspDiagnostics__clear_saved_meta_csp_setting(),
      saved: lazyStrings.DeveloperCspDiagnostics__setting_saved(),
      saving: lazyStrings.DeveloperCspDiagnostics__saving_meta_csp(),
      failed: lazyStrings.DeveloperCspDiagnostics__could_not_save_the_setting(),
      changed: lazyStrings.DeveloperCspDiagnostics__input_or_storage_changed(),
      developmentOnly: lazyStrings.DeveloperCspDiagnostics__only_for_development_never_for_security(),
      persistence: lazyStrings.DeveloperCspDiagnostics__saved_meta_is_added_now_and_on_future_loads(),
      clearNote: lazyStrings.DeveloperCspDiagnostics__clearing_the_setting_keeps_current_meta(),
      cannotRelax: lazyStrings.DeveloperCspDiagnostics__http_header_restrictions_cannot_be_relaxed(),
      savedValue: lazyStrings.DeveloperCspDiagnostics__saved_development_meta_csp_value(),
      noSetting: lazyStrings.DeveloperCspDiagnostics__no_saved_meta_csp_setting(),
      savedTruncated: lazyStrings.DeveloperCspDiagnostics__saved_meta_csp_display_is_truncated(),
      managed: lazyStrings.DeveloperCspDiagnostics__managed_meta_added_to_this_page(),
      metaStatus: lazyStrings.DeveloperCspDiagnostics__development_meta_application_status(),
      managedScope: lazyStrings.DeveloperCspDiagnostics__only_meta_added_through_naidan_is_listed(),
      broker: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_meta_application(),
      brokerNotReady: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_not_ready(),
      brokerPending: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_confirmation_pending(),
      brokerConfirmed: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_additions_confirmed(),
      brokerUnavailable: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_confirmation_unavailable(),
      brokerNotReadyNote: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_not_ready_description(),
      brokerPendingNote: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_confirmation_pending_description(),
      brokerUnavailableNote: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_confirmation_unavailable_description(),
      brokerLimits: lazyStrings.DeveloperCspDiagnostics__privacy_fetch_meta_confirmation_limits(),
      noMeta: lazyStrings.DeveloperCspDiagnostics__no_managed_meta_has_been_added(),
      limited: lazyStrings.DeveloperCspDiagnostics__managed_meta_display_is_limited(),
      incomplete: lazyStrings.DeveloperCspDiagnostics__managed_meta_diagnostics_are_unavailable(),
      metaFailed: lazyStrings.DeveloperCspDiagnostics__meta_could_not_be_added(),
      partlyAdded: lazyStrings.DeveloperCspDiagnostics__only_part_of_the_policy_was_added(),
      recordLength: lazyStrings.DeveloperCspDiagnostics__original_value_length(),
      notFetched: lazyStrings.DeveloperCspDiagnostics__policy_has_not_been_fetched(),
      fetching: lazyStrings.DeveloperCspDiagnostics__fetching_policy(),
      unavailable: lazyStrings.DeveloperCspDiagnostics__policy_could_not_be_observed(),
      noHeader: lazyStrings.DeveloperCspDiagnostics__header_missing(),
      truncated: lazyStrings.DeveloperCspDiagnostics__header_was_truncated(),
      headers: lazyStrings.DeveloperCspDiagnostics__observed_headers(),
      reportOnly: lazyStrings.DeveloperCspDiagnostics__report_only_does_not_block(),
      connections: lazyStrings.DeveloperCspDiagnostics__allowed_connections(),
      noSummary: lazyStrings.DeveloperCspDiagnostics__connection_summary_is_unavailable(),
      parseResult: lazyStrings.DeveloperCspDiagnostics__parse_result(),
      copy: lazyStrings.DeveloperCspDiagnostics__copy(),
      copyJson: lazyStrings.DeveloperCspDiagnostics__copy_json(),
      copied: lazyStrings.DeveloperCspDiagnostics__copied(),
      copyFailed: lazyStrings.DeveloperCspDiagnostics__copy_failed_select_the_text(),
    };
    return Object.values(result).every(value => value !== undefined) ? result : undefined;
  } catch {
    return undefined;
  }
});

const brokerDisplay = computed(() => {
  try {
    const copy = labels.value;
    if (copy === undefined) {
      return undefined;
    }
    const { kind, sessionId: _sessionId, syncId: _syncId, requestedPolicyCount, confirmedPolicyCount, reason: _reason, ...rest } = development.snapshot.value.privacyBroker;
    rest satisfies Record<PropertyKey, never>;
    let description: { label: string | undefined, note: string | undefined, caution: boolean };
    switch (kind) {
    case 'not-created': return { label: copy.brokerNotReady, note: copy.brokerNotReadyNote, prefix: undefined, caution: false };
    case 'pending': description = { label: copy.brokerPending, note: copy.brokerPendingNote, caution: false };
      break;
    case 'confirmed': description = { label: copy.brokerConfirmed, note: undefined, caution: false };
      break;
    case 'unavailable': description = { label: copy.brokerUnavailable, note: copy.brokerUnavailableNote, caution: true };
      break;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
    }
    const prefix = lazyStrings.DeveloperCspDiagnostics__privacy_fetch_confirmed_meta_prefix({ confirmed: confirmedPolicyCount, requested: requestedPolicyCount });
    return prefix === undefined ? undefined : { ...description, prefix };
  } catch {
    return undefined;
  }
});

function presetLabel({ id }: { id: PresetId }): string | undefined {
  switch (id) {
  case 'none': return labels.value?.none;
  case 'local-only': return labels.value?.localOnly;
  case 'curated': return labels.value?.curated;
  default: {
    const exhaustive: never = id;
    return exhaustive;
  }
  }
}

function selectPreset({ id }: { id: PresetId }): void {
  const preset = presets.find(candidate => candidate.id === id);
  if (preset !== undefined) {
    headerDraft.value = preset.serialized;
    draftDirty = true;
    draftStorageCurrent = development.captureStorageForDevelopmentMetaCspNotForSecurity();
  }
}

async function saveMeta(): Promise<void> {
  if (!canSave.value) {
    return;
  }
  const draft = headerDraft.value;
  const serialized = draft === '' ? undefined : draft;
  const revision = draftRevision;
  const storageCurrent = draftStorageCurrent;
  actionFailed.value = false;
  try {
    await development.saveDevelopmentMetaCspNotForSecurity({ serialized, isCurrent: () => storageCurrent() && draftRevision === revision && headerDraft.value === draft });
  } catch {
    actionFailed.value = true;
  }
}

async function clearMeta(): Promise<void> {
  if (busy.value) {
    return;
  }
  actionFailed.value = false;
  try {
    await development.clearDevelopmentMetaCspNotForSecurity();
  } catch {
    actionFailed.value = true;
  }
}

async function copyContent({ target }: { target: CopyTarget }): Promise<void> {
  const requestedSnapshot = snapshot.value;
  copyingJson.value = false;
  let value: string | undefined;
  switch (target) {
  case 'header': value = serverSerialized.value;
    break;
  case 'parsed': copyingJson.value = true;
    value = parsedJson.value;
    break;
  default: {
    const exhaustive: never = target;
    return exhaustive;
  }
  }
  if (value === undefined) {
    copyingJson.value = false;
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    if (snapshot.value === requestedSnapshot) {
      copyStatus.value[target] = 'copied';
    }
  } catch {
    if (snapshot.value === requestedSnapshot) {
      copyStatus.value[target] = 'failed';
    }
  } finally {
    copyingJson.value = false;
  }
}

function toggleParsed({ event }: { event: Event }): void {
  if (event.target instanceof HTMLDetailsElement) {
    parsedExpanded.value = event.target.open;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section v-if="labels !== undefined" data-testid="developer-csp-diagnostics" tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800">
    <div tw-class="space-y-1.5"><h3 tw-class="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200"><ShieldIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ labels.title }}</h3><p tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ labels.description }}</p></div>
    <div tw-class="space-y-3 rounded-xl border border-gray-200/80 bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/30">
      <h4 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ labels.setting }}</h4>
      <p tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ labels.developmentOnly }}</p>
      <div role="group" :aria-label="labels.setting" tw-class="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-gray-100/80 p-0.5 dark:bg-gray-800/70"><button v-for="preset in presets" :key="preset.id" type="button" :aria-pressed="activePreset === preset.id" :data-testid="`developer-csp-preset-${preset.id}`" :tw-class="['min-h-7 rounded-md px-2.5 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 motion-reduce:transition-none', activePreset === preset.id ? 'bg-white text-blue-600 dark:bg-gray-700 dark:text-blue-400' : 'text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-200']" @click="selectPreset({ id: preset.id })">{{ presetLabel({ id: preset.id }) }}</button><span v-if="activePreset === 'custom'" tw-class="px-2 text-xs text-gray-600 dark:text-gray-300">{{ labels.custom }}</span></div>
      <label tw-class="block space-y-2"><span tw-class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ labels.value }}</span><textarea v-model="headerDraft" rows="4" maxlength="65536" spellcheck="false" data-testid="developer-csp-draft" tw-class="block w-full min-w-0 resize-y rounded-xl border border-gray-200/80 bg-gray-50/60 px-3.5 py-2.5 font-mono text-sm leading-relaxed text-gray-800 outline-none transition-colors focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-500/10 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-100 dark:focus:bg-gray-900 motion-reduce:transition-none"></textarea></label>
      <div tw-class="flex flex-wrap items-center gap-2"><ActionButton tw-class="text-sm!" :icon-tone="undefined" appearance="primary" :disabled="!canSave" data-testid="developer-csp-save-meta" @click="saveMeta"><ShieldIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ busy ? labels.saving : labels.save }}</ActionButton><ActionButton tw-class="text-sm!" :icon-tone="undefined" appearance="secondary" :disabled="busy || savedMeta === undefined" data-testid="developer-csp-clear-meta" @click="clearMeta"><XIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />{{ labels.clear }}</ActionButton></div>
      <p tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ labels.persistence }}</p>
      <p tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ labels.clearNote }}</p>
      <p v-if="actionFailed || development.operation.value === 'failed'" role="status" data-testid="developer-csp-meta-save-failed" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ labels.failed }}</p><p v-else-if="development.operation.value === 'changed'" role="status" data-testid="developer-csp-meta-save-changed" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ labels.changed }}</p><p v-else-if="development.operation.value === 'saved'" role="status" data-testid="developer-csp-meta-saved" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.saved }}</p>
      <p role="note" tw-class="flex items-start gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/60 px-3 py-2 text-xs font-medium leading-relaxed text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-900/15 dark:text-emerald-200"><ShieldIcon aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" /><span>{{ labels.cannotRelax }}</span></p>
      <details v-if="savedMeta !== undefined" class="csp-developer-details group"><summary tw-class="flex min-h-8 cursor-pointer items-center gap-1 text-sm text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-300">{{ labels.savedValue }}<ChevronDownIcon aria-hidden="true" tw-class="h-3 w-3 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-180" /></summary><pre data-testid="developer-csp-saved-value" tw-class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50/80 p-3 font-mono text-xs dark:bg-gray-950/50">{{ savedMetaForDisplay }}</pre><p v-if="savedMetaWasTruncated" data-testid="developer-csp-saved-truncated" tw-class="mt-2 text-xs text-amber-700 dark:text-amber-400">{{ labels.savedTruncated }} {{ savedMeta.length }}</p></details><p v-else data-testid="developer-csp-no-saved-setting" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.noSetting }}</p>
    </div>
    <div tw-class="overflow-hidden rounded-xl border border-gray-200/80 bg-white/70 dark:border-gray-800 dark:bg-gray-900/30">
      <details class="csp-developer-details group" data-testid="developer-csp-observed-headers" tw-class="border-b border-gray-200/80 dark:border-gray-800"><summary tw-class="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 dark:text-gray-200 dark:hover:bg-gray-800/40">{{ labels.headers }}<ChevronDownIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-180" /></summary><div tw-class="space-y-3 px-4 pb-4">
        <div tw-class="flex justify-end"><ActionButton tw-class="text-sm!" :icon-tone="undefined" appearance="secondary" :disabled="serverSerialized === undefined" data-testid="developer-csp-copy-header" @click="copyContent({ target: 'header' })"><CheckIcon v-if="copyStatus.header === 'copied'" aria-hidden="true" tw-class="h-4 w-4" /><CopyIcon v-else aria-hidden="true" tw-class="h-4 w-4" />{{ copyStatus.header === 'copied' ? labels.copied : labels.copy }}</ActionButton></div>
        <p v-if="snapshot.observation.kind === 'not-started'" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.notFetched }}</p><p v-else-if="snapshot.observation.kind === 'pending'" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.fetching }}</p><p v-else-if="snapshot.observation.kind === 'unavailable'" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.unavailable }} <code>{{ snapshot.observation.reason }}</code></p>
        <template v-if="serverHeaders !== undefined"><div><p tw-class="mb-1.5 font-mono text-xs text-gray-600 dark:text-gray-300">Content-Security-Policy</p><pre v-if="serverHeaders.enforce !== undefined" data-testid="developer-csp-observed-enforce" tw-class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50/80 p-3 font-mono text-xs leading-relaxed text-gray-600 dark:bg-gray-950/50 dark:text-gray-300">{{ serverHeaders.enforce.serialized }}</pre><p v-else data-testid="developer-csp-missing-header" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.noHeader }}</p><p v-if="serverHeaders.enforce?.capture === 'truncated'" tw-class="mt-2 text-xs text-amber-700 dark:text-amber-400">{{ labels.truncated }} {{ serverHeaders.enforce.originalLength }}</p></div><div tw-class="border-t border-gray-100 pt-3 dark:border-gray-800"><p tw-class="mb-1.5 font-mono text-xs text-gray-600 dark:text-gray-300">Content-Security-Policy-Report-Only</p><pre v-if="serverHeaders.reportOnly !== undefined" tw-class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ serverHeaders.reportOnly.serialized }}</pre><p v-else tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.noHeader }}</p><p v-if="serverHeaders.reportOnly?.capture === 'truncated'" tw-class="mt-2 text-xs text-amber-700 dark:text-amber-400">{{ labels.truncated }} {{ serverHeaders.reportOnly.originalLength }}</p><p v-if="serverHeaders.reportOnly !== undefined" tw-class="mt-2 text-xs text-gray-600 dark:text-gray-300">{{ labels.reportOnly }}</p></div></template><p v-if="copyStatus.header === 'failed'" role="status" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.copyFailed }}</p>
      </div></details>
      <details class="csp-developer-details group" data-testid="developer-csp-managed-meta" tw-class="border-b border-gray-200/80 dark:border-gray-800">
        <summary tw-class="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 dark:text-gray-200 dark:hover:bg-gray-800/40"><span>{{ labels.metaStatus }}</span><ChevronDownIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-180" /></summary>
        <div tw-class="space-y-3 px-4 pb-4">
          <h4 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ labels.managed }} · {{ managedMeta.originalCount }}</h4>
          <p tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.managedScope }}</p>
          <p v-if="managedMeta.originalCount === 0" data-testid="developer-csp-no-managed-meta" tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.noMeta }}</p>
          <div v-for="(record, index) in managedMeta.records" :key="index" data-testid="developer-csp-meta-record" tw-class="space-y-2 border-t border-gray-100 pt-3 first:border-t-0 first:pt-0 dark:border-gray-800">
            <p tw-class="text-xs text-gray-600 dark:text-gray-300"><span tw-class="font-medium">#{{ index + 1 }}</span> · <code>{{ record.source }}</code> · {{ labels.recordLength }} {{ record.originalLength }} · meta {{ record.originalPolicyCount }}</p>
            <pre v-for="(policy, policyIndex) in record.policies" :key="policyIndex" data-testid="developer-csp-installed-value" tw-class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-50/80 p-3 font-mono text-xs leading-relaxed text-gray-600 dark:bg-gray-950/50 dark:text-gray-300">{{ policy }}</pre>
          </div>
          <p v-if="managedMeta.capture === 'truncated'" data-testid="developer-csp-managed-truncated" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ labels.limited }} {{ managedMeta.originalCount }}</p>
          <p v-if="development.snapshot.value.diagnostics === 'unavailable'" data-testid="developer-csp-meta-diagnostics-unavailable" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ labels.incomplete }}</p>
          <p v-if="development.snapshot.value.preparation === 'unavailable'" role="status" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ labels.metaFailed }} <code>{{ development.snapshot.value.reason }}</code></p>
          <p v-if="development.snapshot.value.installation.kind === 'partly-added'" role="status" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ labels.partlyAdded }}</p>
          <section v-if="brokerDisplay !== undefined" data-testid="developer-csp-privacy-fetch" tw-class="space-y-1.5 border-t border-gray-100 pt-3 text-xs leading-relaxed text-gray-600 dark:border-gray-800 dark:text-gray-300">
            <div tw-class="flex flex-wrap items-center justify-between gap-2"><h4 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ labels.broker }}</h4><span data-testid="developer-csp-privacy-fetch-status" :tw-class="['rounded-md px-1.5 py-0.5 text-xs', brokerDisplay.caution ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300' : 'bg-gray-100/80 text-gray-600 dark:bg-gray-800/70 dark:text-gray-300']">{{ brokerDisplay.label }}</span></div>
            <p v-if="brokerDisplay.prefix !== undefined" data-testid="developer-csp-privacy-fetch-prefix">{{ brokerDisplay.prefix }}</p>
            <p v-if="brokerDisplay.note !== undefined">{{ brokerDisplay.note }}</p>
            <p>{{ labels.brokerLimits }}</p>
          </section>
        </div>
      </details>
      <section data-testid="developer-csp-connection-summary" tw-class="space-y-2 border-b border-gray-200/80 px-4 py-4 dark:border-gray-800"><h4 tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ labels.connections }}</h4><CspHintDetails v-if="connectionRows !== undefined && connectionRows.length > 0" :rows="connectionRows" :policy-note="policyNote" technical-details="expanded" :technical-details-label="undefined" tw-class="text-gray-600 dark:text-gray-300" /><p v-else tw-class="text-xs text-gray-600 dark:text-gray-300">{{ labels.noSummary }}</p></section>
      <details class="csp-developer-details group" data-testid="developer-csp-json-details" @toggle="toggleParsed({ event: $event })"><summary tw-class="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 dark:text-gray-200 dark:hover:bg-gray-800/40">{{ labels.parseResult }} · JSON<ChevronDownIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-180" /></summary><div tw-class="px-4 pb-4"><div tw-class="mb-2 flex justify-end"><ActionButton tw-class="text-sm!" :icon-tone="undefined" appearance="secondary" :disabled="false" data-testid="developer-csp-copy-json" @click="copyContent({ target: 'parsed' })"><CheckIcon v-if="copyStatus.parsed === 'copied'" aria-hidden="true" tw-class="h-4 w-4" /><CopyIcon v-else aria-hidden="true" tw-class="h-4 w-4" />{{ copyStatus.parsed === 'copied' ? labels.copied : labels.copyJson }}</ActionButton></div><AllowedHtmlView v-if="parsedExpanded && parsedHtml !== undefined" as="pre" :html="parsedHtml" data-testid="developer-csp-parsed-json" tw-class="max-h-72 overflow-auto rounded-xl bg-gray-50/80 p-3 font-mono text-xs leading-relaxed text-gray-600 dark:bg-gray-950/50 dark:text-gray-300" /><p v-if="copyStatus.parsed === 'failed'" role="status" tw-class="mt-2 text-xs text-gray-600 dark:text-gray-300">{{ labels.copyFailed }}</p></div></details>
    </div>
  </section>
</template>
<style scoped>
.csp-developer-details > summary {
  list-style: none;
}
.csp-developer-details > summary::-webkit-details-marker {
  display: none;
}
</style>
