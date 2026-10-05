<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { ChevronDownIcon, PlusIcon, XIcon } from 'lucide-vue-next';
import { useSettings } from '@/composables/useSettings';
import { idToRaw } from '@/01-models/ids';
import type { Endpoint } from '@/01-models/types';
import type { ImageGenerationTranslationOverride } from '@/01-models/image-generation';
import { cloneEndpoint } from '@/01-models/endpoint';
import { loadLmProvider } from '@/features/lm/providerFactory';
import ModelSelector from '@/components/ModelSelector.vue';
import { ensureStrings, lazyStrings } from '@/strings';
import type { ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';
import { cloneImagePromptTranslationOverride, imagePromptTranslationEndpointLabel, resolveImagePromptTranslation } from '@/features/image-generation/translation/settings';
import ImageSettingsSection from './ImageSettingsSection.vue';
const props = defineProps<{ workspace: ImageGenerationWorkspaceView, scope: 'session' | 'workspace' }>();
const { settings } = useSettings();
const draft = ref<ImageGenerationTranslationOverride>({ endpoint: undefined, modelId: undefined });
const models = ref<string[]>([]), loading = ref(false), saving = ref(false), failure = ref(''), saved = ref(false);
let controller: AbortController | undefined, epoch = 0, disposed = false;
const isSessionScope = computed(() => {
  switch (props.scope) {
  case 'session': return true;
  case 'workspace': return false;
  default: { const exhaustive: never = props.scope; throw new Error(String(exhaustive)); }
  }
});
const owner = computed(() => [props.scope, props.workspace.store.value?.storeId, isSessionScope.value ? props.workspace.selectedSessionId.value : undefined] as const);
const stored = computed(() => isSessionScope.value ? props.workspace.currentSession.value?.translation : props.workspace.catalog.value?.preferences.translation);
watch([owner, stored], () => {
  epoch++; controller?.abort(); loading.value = false; models.value = []; failure.value = ''; saved.value = false;
  draft.value = cloneImagePromptTranslationOverride({ value: stored.value }) ?? { endpoint: undefined, modelId: undefined };
}, { immediate: true });
const effective = computed(() => resolveImagePromptTranslation({
  session: isSessionScope.value ? draft.value : undefined,
  workspace: !isSessionScope.value ? draft.value : props.workspace.catalog.value?.preferences.translation,
  global: { endpoint: settings.value.endpoint, modelId: settings.value.defaultModelId },
}));
const endpointLabel = computed(() => imagePromptTranslationEndpointLabel({ endpoint: effective.value.endpoint }));
const endpointOptions = ['inherit', 'openai', 'ollama', 'transformers_js', 'llama_cpp_browser', 'browser_provided_lm'] as const;
function endpointChoice({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const raw = event.target.value;
  const value = endpointOptions.find(option => option === raw);
  if (!value) return;
  switch (value) {
  case 'inherit': draft.value.endpoint = undefined; break;
  case 'openai': case 'ollama': draft.value.endpoint = { type: value, url: '', httpHeaders: undefined }; break;
  case 'transformers_js': case 'llama_cpp_browser': case 'browser_provided_lm': draft.value.endpoint = { type: value }; break;
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}
function profileChoice({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const raw = event.target.value;
  const profile = settings.value.providerProfiles.find(item => idToRaw({ id: item.id }) === raw);
  if (profile) draft.value = { endpoint: cloneEndpoint({ endpoint: profile.endpoint }), modelId: profile.defaultModelId };
  event.target.value = '';
}
const httpEndpoint = computed(() => {
  const endpoint = draft.value.endpoint;
  return endpoint?.type === 'openai' || endpoint?.type === 'ollama' ? endpoint : undefined;
});
function addHeader(): void {
  if (httpEndpoint.value) (httpEndpoint.value.httpHeaders ??= []).push(['', '']);
}
function changeModel({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) draft.value.modelId = event.target.value || undefined;
}
watch(() => JSON.stringify(draft.value), () => {
  saved.value = false;
});
watch(() => JSON.stringify(effective.value.endpoint), () => {
  epoch++; controller?.abort(); loading.value = false; models.value = [];
}, { flush: 'sync' });
async function fetchModels(): Promise<void> {
  if (saving.value || props.workspace.busy.value) return;
  controller?.abort(); const abort = new AbortController(); controller = abort;
  const token = ++epoch; loading.value = true; failure.value = '';
  try {
    const endpoint: Endpoint = cloneEndpoint({ endpoint: effective.value.endpoint });
    const provider = await loadLmProvider({ endpoint, fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled' });
    abort.signal.throwIfAborted();
    const values = await provider.listModels({ signal: abort.signal });
    if (!disposed && token === epoch) models.value = values;
  } catch (error) {
    if (!disposed && token === epoch && !abort.signal.aborted) failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (!disposed && token === epoch) loading.value = false;
  }
}
async function save(): Promise<void> {
  if (saving.value || props.workspace.busy.value) return;
  saving.value = true; failure.value = ''; saved.value = false;
  const ownerKey = JSON.stringify(owner.value), submitted = JSON.stringify(draft.value);
  const stillCurrent = () => !disposed && JSON.stringify(owner.value) === ownerKey && JSON.stringify(draft.value) === submitted;
  const value = cloneImagePromptTranslationOverride({ value: draft.value });
  const translation = value?.endpoint === undefined && value?.modelId === undefined ? undefined : value;
  try {
    const success = isSessionScope.value ? await props.workspace.updateSessionTranslation({ translation })
      : await props.workspace.updatePreferences({ change: { type: 'translation', translation } });
    if (stillCurrent()) {
      saved.value = success;
      if (!success) {
        const message = props.workspace.failure.value || await ensureStrings.imageGeneration__translation_settings_not_saved();
        if (stillCurrent()) failure.value = message;
      }
    }
  } catch (error) {
    if (stillCurrent()) failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}
onScopeDispose(() => {
  disposed = true; epoch++; controller?.abort();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <fieldset :disabled="saving || workspace.busy.value" tw-class="space-y-3 text-xs min-w-0" data-testid="translation-settings">
    <p tw-class="leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__translation_priority() }}</p>
    <label v-if="settings.providerProfiles.length" tw-class="block space-y-1">
      <span>{{ lazyStrings.imageGeneration__translation_profile() }}</span>
      <span tw-class="relative block"><select @change="profileChoice({ event: $event })" tw-class="appearance-none w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2"><option value="">{{ lazyStrings.imageGeneration__translation_profile() }}</option><option v-for="profile in settings.providerProfiles" :key="idToRaw({ id: profile.id })" :value="idToRaw({ id: profile.id })">{{ profile.name }}</option></select><ChevronDownIcon tw-class="pointer-events-none absolute right-3 top-2 w-4 h-4" /></span>
    </label>
    <label tw-class="block space-y-1">
      <span>{{ lazyStrings.imageGeneration__translation_endpoint() }}</span>
      <span tw-class="relative block"><select :value="draft.endpoint?.type ?? 'inherit'" @change="endpointChoice({ event: $event })" data-testid="translation-endpoint-choice" tw-class="appearance-none w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"><option v-for="choice in endpointOptions" :key="choice" :value="choice">{{ choice === 'inherit' ? lazyStrings.imageGeneration__translation_inherit() : choice }}</option><option v-if="draft.endpoint?.type === 'unsupported_experimental_endpoint'" value="unsupported_experimental_endpoint">{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option></select><ChevronDownIcon tw-class="pointer-events-none absolute right-3 top-2 w-4 h-4" /></span>
    </label>
    <template v-if="httpEndpoint">
      <label tw-class="block space-y-1"><span>URL</span><input v-model="httpEndpoint.url" type="url" spellcheck="false" data-testid="translation-endpoint-url" tw-class="w-full min-w-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" /></label>
      <ImageSettingsSection compact :title="lazyStrings.imageGeneration__translation_headers()" :summary="undefined">
        <div v-for="(header, index) in httpEndpoint.httpHeaders" :key="index" tw-class="flex items-center gap-2">
          <input v-model="header[0]" :aria-label="lazyStrings.imageGeneration__translation_header_name()" spellcheck="false" tw-class="w-1/3 min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5" />
          <input v-model="header[1]" :aria-label="lazyStrings.imageGeneration__translation_header_value()" type="password" autocomplete="off" tw-class="min-w-0 flex-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5" />
          <button type="button" @click="httpEndpoint.httpHeaders?.splice(index, 1)" :aria-label="lazyStrings.imageGeneration__translation_remove_header()" tw-class="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"><XIcon tw-class="w-4 h-4" /></button>
        </div>
        <button type="button" @click="addHeader" tw-class="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-blue-600 dark:text-blue-400"><PlusIcon tw-class="w-4 h-4" />{{ lazyStrings.imageGeneration__translation_add_header() }}</button>
      </ImageSettingsSection>
    </template>
    <div tw-class="space-y-1">
      <label tw-class="block space-y-1"><span>{{ lazyStrings.imageGeneration__translation_model() }}</span><input :value="draft.modelId ?? ''" @input="changeModel({ event: $event })" :placeholder="effective.modelId || lazyStrings.imageGeneration__translation_inherit()" data-testid="translation-model-input" tw-class="w-full min-w-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" /></label>
      <ModelSelector v-model="draft.modelId" :models="models" :loading="loading" :disabled="saving || workspace.busy.value" allow-clear :clear-label="lazyStrings.imageGeneration__translation_inherit()" @refresh="fetchModels" />
    </div>
    <p tw-class="break-words text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__translation_effective() }}: {{ endpointLabel }} · {{ effective.modelId || '—' }}</p>
    <div tw-class="flex flex-wrap items-center gap-2">
      <button type="button" @click="save" :disabled="saving || workspace.busy.value || !workspace.available.value" data-testid="translation-settings-save" tw-class="rounded-lg px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__translation_save_settings() }}</button>
      <button type="button" @click="draft = { endpoint: undefined, modelId: undefined }" :disabled="saving" tw-class="rounded-lg px-2 py-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">{{ lazyStrings.imageGeneration__translation_reset() }}</button>
      <span v-if="saved" role="status" tw-class="text-green-600 dark:text-green-400">{{ lazyStrings.imageGeneration__draft_saved() }}</span>
    </div>
    <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ failure }}</p>
  </fieldset>
</template>
