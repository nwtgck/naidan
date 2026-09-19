<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { ensureStrings, lazyStrings } from '@/strings';
import { useConfirm } from '@/composables/useConfirm';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { errorCode, runtimeOptionsSchema, type EngineState, type LocalModel } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserLoadingIndicator from './LlamaCppBrowserLoadingIndicator.vue';

const state = shallowRef<EngineState>(llamaCppBrowserService.getState());
const models = ref<LocalModel[]>([]);
const options = ref(llamaCppBrowserService.getOptions());
const localError = ref<string>();
const active = ref<AbortController>();
const unavailable = computed(() => __BUILD_MODE_IS_STANDALONE__ || state.value.status === 'unavailable');
const busy = computed(() => active.value !== undefined || state.value.status === 'working');
const { showConfirm } = useConfirm();
let unsubscribe: (() => void) | undefined;
async function refresh(): Promise<void> {
  if (unavailable.value) return;
  try {
    models.value = await llamaCppBrowserService.listModels({ signal: undefined });
  } catch (error) {
    localError.value = errorCode({ error });
  }
}
async function importFile({ event }: { event: Event }): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || unavailable.value || busy.value) return;
  const file = input.files?.[0]; input.value = '';
  if (!file) return;
  const controller = new AbortController(); active.value = controller; localError.value = undefined;
  try {
    await llamaCppBrowserService.importModel({ file, signal: controller.signal }); await refresh();
  } catch (error) {
    if (!controller.signal.aborted) localError.value = errorCode({ error });
  } finally {
    active.value = undefined;
  }
}
async function remove({ id }: { id: string }): Promise<void> {
  if (unavailable.value || busy.value) return;
  if (!await showConfirm({ message: await ensureStrings.llamaCppBrowser__delete_model_confirmation(), confirmButtonVariant: 'danger' })) return;
  const controller = new AbortController(); active.value = controller; localError.value = undefined;
  try {
    await llamaCppBrowserService.removeModel({ id, signal: controller.signal }); await refresh();
  } catch (error) {
    localError.value = errorCode({ error });
  } finally {
    active.value = undefined;
  }
}
function applyOptions(): void {
  const parsed = runtimeOptionsSchema.safeParse(options.value);
  if (parsed.success) llamaCppBrowserService.setOptions({ options: parsed.data });
}
function cancel(): void {
  active.value?.abort(); llamaCppBrowserService.cancel();
}
onMounted(() => {
  unsubscribe = llamaCppBrowserService.subscribe({ listener: ({ state: next }) => {
    state.value = next;
  } });
  void refresh();
});
onUnmounted(() => {
  active.value?.abort(); unsubscribe?.();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5" data-testid="llama-cpp-browser-manager">
    <h2 tw-class="text-lg font-bold text-gray-900 dark:text-white">{{ lazyStrings.llamaCppBrowser__manage_gguf_models() }}</h2>
    <p tw-class="text-sm text-gray-600 dark:text-gray-300">{{ lazyStrings.llamaCppBrowser__import_downloaded_gguf() }}</p>
    <p v-if="unavailable" tw-class="p-3 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-500" data-testid="llama-cpp-browser-unavailable">{{ lazyStrings.llamaCppBrowser__unavailable_in_standalone() }}</p>
    <p tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.llamaCppBrowser__text_chat_only() }}</p>
    <fieldset :disabled="unavailable || busy" tw-class="space-y-4 disabled:opacity-50">
      <label tw-class="block text-sm font-semibold">
        {{ lazyStrings.llamaCppBrowser__import_gguf() }}
        <input type="file" accept=".gguf" data-testid="llama-cpp-browser-file" tw-class="block w-full mt-2 text-sm" @change="importFile({ event: $event })" />
      </label>
      <label tw-class="block text-sm">
        {{ lazyStrings.llamaCppBrowser__profile() }}
        <select v-model="options.profile" data-testid="llama-cpp-browser-profile" tw-class="block w-full p-2 rounded-lg bg-gray-100 dark:bg-gray-800" @change="applyOptions">
          <option value="webgpu-wasm64-jspi">WebGPU / wasm64</option>
          <option value="cpu-wasm64">CPU / wasm64</option>
          <option value="cpu-wasm32">CPU / wasm32</option>
        </select>
      </label>
      <label tw-class="block text-sm">
        {{ lazyStrings.llamaCppBrowser__context_size() }}
        <input v-model.number="options.contextSize" type="number" min="128" max="32768" step="128" data-testid="llama-cpp-browser-context" tw-class="block w-full p-2 rounded-lg bg-gray-100 dark:bg-gray-800" @change="applyOptions" />
      </label>
      <div tw-class="flex gap-3 flex-wrap">
        <button type="button" tw-class="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800" @click="refresh">{{ lazyStrings.llamaCppBrowser__refresh_models() }}</button>
        <button type="button" tw-class="px-3 py-2 rounded-lg bg-gray-100 dark:bg-gray-800" @click="llamaCppBrowserService.release()">{{ lazyStrings.llamaCppBrowser__release_runtime() }}</button>
      </div>
    </fieldset>
    <button v-if="busy" type="button" data-testid="llama-cpp-browser-cancel" tw-class="px-3 py-2 rounded-lg bg-red-100 text-red-700" @click="cancel">{{ lazyStrings.SHARED__cancel() }}</button>
    <LlamaCppBrowserLoadingIndicator />
    <p v-if="localError" role="alert" tw-class="text-sm text-red-600">{{ lazyStrings.llamaCppBrowser__operation_failed() }} <code>{{ localError }}</code></p>
    <p v-if="models.length === 0" tw-class="text-sm text-gray-500">{{ lazyStrings.llamaCppBrowser__no_imported_models() }}</p>
    <ul v-else tw-class="space-y-2">
      <li v-for="model in models" :key="model.id" tw-class="flex gap-3 items-center justify-between border border-gray-200 dark:border-gray-700 rounded-lg p-3">
        <span tw-class="min-w-0 break-all text-sm">{{ model.name }} <span tw-class="text-gray-500">{{ (model.size / 1024 ** 3).toFixed(2) }} GiB</span></span>
        <button type="button" :disabled="unavailable || busy" :data-testid="`llama-cpp-browser-delete-${model.id}`" tw-class="text-sm text-red-600 disabled:opacity-50" @click="remove({ id: model.id })">{{ lazyStrings.llamaCppBrowser__delete_model() }}</button>
      </li>
    </ul>
    <p tw-class="text-xs text-gray-500">{{ lazyStrings.llamaCppBrowser__import_then_select() }}</p>
  </section>
</template>
