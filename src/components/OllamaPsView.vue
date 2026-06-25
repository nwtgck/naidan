<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import {
  AlertCircleIcon,
  ChevronDownIcon,
  CircleStopIcon,
  Clock3Icon,
  Loader2Icon,
  MemoryStickIcon,
  RefreshCwIcon,
} from 'lucide-vue-next';
import { useToast } from '@/composables/useToast';
import type { OllamaProvider, OllamaRunningModel } from '@/services/lm/ollama';

type PanelState = 'collapsed' | 'expanded';
type DetailsState = 'collapsed' | 'expanded';
type ModelActionState = 'idle' | 'unloading' | 'requested' | 'failed';
type UnloadConfirmation =
  | { status: 'unloaded', models: readonly OllamaRunningModel[] }
  | { status: 'requested', models: readonly OllamaRunningModel[] };

const UNLOAD_CONFIRMATION_ATTEMPTS = 20;
const UNLOAD_CONFIRMATION_INTERVAL_MS = 100;
type PsRequestState =
  | { status: 'idle' }
  | { status: 'loading', previousModels: readonly OllamaRunningModel[] }
  | { status: 'ready', models: readonly OllamaRunningModel[] }
  | { status: 'error', errorMessage: string, previousModels: readonly OllamaRunningModel[] };

const props = defineProps<{
  provider: OllamaProvider,
  endpointUrl: string | undefined,
}>();

const { addToast } = useToast();
const panelState = ref<PanelState>('collapsed');
const requestState = ref<PsRequestState>({ status: 'idle' });
const detailsStates = reactive(new Map<string, DetailsState>());
const modelActionStates = reactive(new Map<string, ModelActionState>());
const modelActionErrors = reactive(new Map<string, string>());
const modelActionNotices = reactive(new Map<string, string>());
let listAbortController: AbortController | undefined;
let unloadAbortController: AbortController | undefined;

const isExpanded = computed(() => panelState.value === 'expanded');
const models = computed(() => getModelsFromRequestState({ state: requestState.value }));
const isRefreshing = computed(() => requestState.value.status === 'loading');
const isAnyModelUnloading = computed(() => Array.from(modelActionStates.values()).some((state) => state === 'unloading'));
const hasEndpoint = computed(() => (props.endpointUrl?.trim().length ?? 0) > 0);
const statusLabel = computed(() => {
  switch (requestState.value.status) {
  case 'idle':
    return 'Not checked';
  case 'loading':
    return requestState.value.previousModels.length === 0
      ? 'Checking…'
      : `${requestState.value.previousModels.length} loaded`;
  case 'ready':
    return `${requestState.value.models.length} loaded`;
  case 'error':
    return requestState.value.previousModels.length === 0
      ? 'Unavailable'
      : `${requestState.value.previousModels.length} loaded`;
  default: {
    const _ex: never = requestState.value;
    throw new Error(`Unhandled request state: ${String(_ex)}`);
  }
  }
});

function getModelsFromRequestState({ state }: {
  state: PsRequestState,
}): readonly OllamaRunningModel[] {
  switch (state.status) {
  case 'idle':
    return [];
  case 'loading':
  case 'error':
    return state.previousModels;
  case 'ready':
    return state.models;
  default: {
    const _ex: never = state;
    throw new Error(`Unhandled request state: ${String(_ex)}`);
  }
  }
}

async function togglePanel() {
  switch (panelState.value) {
  case 'collapsed':
    panelState.value = 'expanded';
    if (requestState.value.status === 'idle' && hasEndpoint.value) {
      await loadRunningModels();
    }
    return;
  case 'expanded':
    panelState.value = 'collapsed';
    return;
  default: {
    const _ex: never = panelState.value;
    throw new Error(`Unhandled panel state: ${_ex}`);
  }
  }
}

async function loadRunningModels(): Promise<readonly OllamaRunningModel[] | undefined> {
  if (!hasEndpoint.value) {
    requestState.value = { status: 'idle' };
    return undefined;
  }

  listAbortController?.abort();
  const controller = new AbortController();
  listAbortController = controller;
  const previousModels = models.value;
  requestState.value = { status: 'loading', previousModels };

  try {
    const nextModels = await props.provider.listRunningModels({ signal: controller.signal });
    if (listAbortController !== controller) {
      return undefined;
    }

    requestState.value = { status: 'ready', models: nextModels };
    removeStaleModelState({ nextModels });
    return nextModels;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return undefined;
    }
    if (listAbortController !== controller) {
      return undefined;
    }

    requestState.value = {
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
      previousModels,
    };
    return undefined;
  } finally {
    if (listAbortController === controller) {
      listAbortController = undefined;
    }
  }
}

function removeStaleModelState({ nextModels }: {
  nextModels: readonly OllamaRunningModel[],
}) {
  const names = new Set(nextModels.map((model) => model.name));
  for (const name of detailsStates.keys()) {
    if (!names.has(name)) {
      detailsStates.delete(name);
    }
  }
  for (const name of modelActionStates.keys()) {
    if (!names.has(name)) {
      modelActionStates.delete(name);
      modelActionErrors.delete(name);
      modelActionNotices.delete(name);
    }
  }
}

async function unloadModel({ model }: {
  model: OllamaRunningModel,
}) {
  if (isRefreshing.value || isAnyModelUnloading.value) {
    return;
  }

  const modelIdentifier = model.model ?? model.name;
  const provider = props.provider;
  modelActionStates.set(model.name, 'unloading');
  modelActionErrors.delete(model.name);
  modelActionNotices.delete(model.name);
  unloadAbortController?.abort();
  const controller = new AbortController();
  unloadAbortController = controller;

  try {
    await provider.unloadModel({
      model: modelIdentifier,
      signal: controller.signal,
    });
    if (unloadAbortController !== controller) {
      return;
    }

    const confirmation = await confirmModelUnload({
      provider,
      modelIdentifier,
      controller,
    });
    if (confirmation === undefined || unloadAbortController !== controller) {
      return;
    }

    requestState.value = { status: 'ready', models: confirmation.models };
    removeStaleModelState({ nextModels: confirmation.models });

    switch (confirmation.status) {
    case 'unloaded':
      addToast({
        message: `${model.name} unloaded`,
        duration: 3000,
      });
      return;
    case 'requested':
      modelActionStates.set(model.name, 'requested');
      modelActionNotices.set(
        model.name,
        'Unload requested. Ollama may keep showing this model until active requests finish; refresh to check again.',
      );
      addToast({
        message: `${model.name} unload requested`,
        duration: 3000,
      });
      return;
    default: {
      const _ex: never = confirmation;
      throw new Error(`Unhandled unload confirmation: ${String(_ex)}`);
    }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return;
    }
    if (unloadAbortController !== controller) {
      return;
    }

    modelActionStates.set(model.name, 'failed');
    modelActionErrors.set(model.name, error instanceof Error ? error.message : String(error));
  } finally {
    if (unloadAbortController === controller) {
      unloadAbortController = undefined;
    }
    finishModelAction({ modelName: model.name });
  }
}

async function confirmModelUnload({ provider, modelIdentifier, controller }: {
  provider: OllamaProvider,
  modelIdentifier: string,
  controller: AbortController,
}): Promise<UnloadConfirmation | undefined> {
  let latestModels = models.value;

  for (let attempt = 0; attempt < UNLOAD_CONFIRMATION_ATTEMPTS; attempt++) {
    await waitForAbortableDelay({
      delayMs: UNLOAD_CONFIRMATION_INTERVAL_MS,
      signal: controller.signal,
    });
    if (unloadAbortController !== controller) {
      return undefined;
    }

    latestModels = await provider.listRunningModels({ signal: controller.signal });
    if (unloadAbortController !== controller) {
      return undefined;
    }

    const isStillLoaded = latestModels.some(
      (nextModel) => (nextModel.model ?? nextModel.name) === modelIdentifier,
    );
    if (!isStillLoaded) {
      return { status: 'unloaded', models: latestModels };
    }
  }

  return { status: 'requested', models: latestModels };
}

function waitForAbortableDelay({ delayMs, signal }: {
  delayMs: number,
  signal: AbortSignal,
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function finishModelAction({ modelName }: {
  modelName: string,
}) {
  const finalActionState = modelActionStates.get(modelName) ?? 'idle';
  switch (finalActionState) {
  case 'unloading':
    modelActionStates.set(modelName, 'idle');
    return;
  case 'idle':
  case 'requested':
  case 'failed':
    return;
  default: {
    const _ex: never = finalActionState;
    throw new Error(`Unhandled model action state: ${_ex}`);
  }
  }
}

function toggleModelDetails({ modelName }: {
  modelName: string,
}) {
  const currentState = detailsStates.get(modelName) ?? 'collapsed';
  switch (currentState) {
  case 'collapsed':
    detailsStates.set(modelName, 'expanded');
    return;
  case 'expanded':
    detailsStates.set(modelName, 'collapsed');
    return;
  default: {
    const _ex: never = currentState;
    throw new Error(`Unhandled details state: ${_ex}`);
  }
  }
}

function isModelDetailsExpanded({ modelName }: {
  modelName: string,
}): boolean {
  return (detailsStates.get(modelName) ?? 'collapsed') === 'expanded';
}

function getModelActionState({ modelName }: {
  modelName: string,
}): ModelActionState {
  return modelActionStates.get(modelName) ?? 'idle';
}

function getUnloadButtonLabel({ modelName }: {
  modelName: string,
}): string {
  const actionState = getModelActionState({ modelName });
  switch (actionState) {
  case 'idle':
  case 'failed':
    return 'Unload';
  case 'unloading':
    return 'Unloading…';
  case 'requested':
    return 'Unload requested';
  default: {
    const _ex: never = actionState;
    throw new Error(`Unhandled model action state: ${_ex}`);
  }
  }
}

function getModelMetadata({ model }: {
  model: OllamaRunningModel,
}): readonly string[] {
  return [
    formatBytes({ value: model.size, label: 'memory' }),
    formatBytes({ value: model.sizeVram, label: 'VRAM' }),
    model.contextLength === undefined ? undefined : `${model.contextLength.toLocaleString()} context`,
    formatExpiration({ value: model.expiresAt }),
  ].filter((value): value is string => value !== undefined);
}

function getModelDetails({ model }: {
  model: OllamaRunningModel,
}): readonly { readonly label: string, readonly value: string }[] {
  const families = model.details.families?.filter((family) => family.length > 0).join(', ');
  return [
    model.model !== undefined && model.model !== '' && model.model !== model.name ? { label: 'Model', value: model.model } : undefined,
    model.details.format === undefined || model.details.format === '' ? undefined : { label: 'Format', value: model.details.format },
    model.details.family === undefined || model.details.family === '' ? undefined : { label: 'Family', value: model.details.family },
    families === undefined || families === '' ? undefined : { label: 'Families', value: families },
    model.details.parentModel === undefined || model.details.parentModel === ''
      ? undefined
      : { label: 'Parent model', value: model.details.parentModel },
    model.digest === undefined || model.digest === '' ? undefined : { label: 'Digest', value: model.digest },
  ].filter((value): value is { readonly label: string, readonly value: string } => value !== undefined);
}

function formatBytes({ value, label }: {
  value: number | undefined,
  label: string,
}): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const gibibyte = 1024 ** 3;
  const mebibyte = 1024 ** 2;
  if (value >= gibibyte) {
    return `${(value / gibibyte).toFixed(1)} GB ${label}`;
  }
  return `${Math.max(1, Math.round(value / mebibyte)).toLocaleString()} MB ${label}`;
}

function formatExpiration({ value }: {
  value: string | undefined,
}): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const now = Date.now();
  if (timestamp - now > 1000 * 60 * 60 * 24 * 365 * 100) {
    return 'Kept indefinitely';
  }

  const remainingMinutes = Math.ceil((timestamp - now) / (1000 * 60));
  if (remainingMinutes <= 1) {
    return 'Expires soon';
  }
  if (remainingMinutes < 60) {
    return `Expires in ${remainingMinutes} minutes`;
  }

  return `Expires ${new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))}`;
}

function resetForProviderChange() {
  listAbortController?.abort();
  unloadAbortController?.abort();
  listAbortController = undefined;
  unloadAbortController = undefined;
  requestState.value = { status: 'idle' };
  detailsStates.clear();
  modelActionStates.clear();
  modelActionErrors.clear();
  modelActionNotices.clear();
}

watch(() => props.provider, () => {
  resetForProviderChange();
});

onBeforeUnmount(() => {
  listAbortController?.abort();
  unloadAbortController?.abort();
});

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div
    class="overflow-hidden rounded-3xl border border-gray-100 bg-gray-50/50 shadow-sm dark:border-gray-800 dark:bg-gray-800/30"
    data-testid="ollama-ps-view"
  >
    <div class="flex items-center gap-2 bg-white/60 px-4 py-3.5 dark:bg-gray-900/25 sm:px-5">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        :aria-expanded="isExpanded"
        aria-controls="ollama-running-models-content"
        data-testid="ollama-ps-toggle"
        @click="togglePanel"
      >
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-white text-blue-500 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <MemoryStickIcon class="h-4 w-4" />
        </span>

        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="text-sm font-bold text-gray-800 dark:text-gray-100">Running Models</span>
            <span
              class="text-[10px] font-bold text-gray-400"
              aria-live="polite"
              data-testid="ollama-ps-status"
            >
              {{ statusLabel }}
            </span>
          </span>
          <span class="mt-0.5 block text-[11px] font-medium leading-4 text-gray-400">
            Models currently using system or video memory.
          </span>
        </span>

        <ChevronDownIcon
          class="h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 motion-reduce:transition-none"
          :class="isExpanded ? 'rotate-180' : ''"
        />
      </button>
    </div>

    <div
      id="ollama-running-models-content"
      class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
      :class="isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
      role="region"
      aria-label="Running Ollama models"
      :aria-hidden="!isExpanded"
      :inert="isExpanded ? undefined : true"
      data-testid="ollama-ps-content"
    >
      <div class="overflow-hidden">
        <div
          class="border-t border-gray-100 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none dark:border-gray-800"
          :class="isExpanded ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'"
        >
          <div v-if="hasEndpoint" class="flex flex-wrap items-center justify-between gap-3 bg-gray-50/60 px-4 py-2.5 dark:bg-gray-900/20 sm:px-5">
            <p class="text-[10px] font-medium leading-4 text-gray-400">
              Loaded models remain available until their keep-alive period expires.
            </p>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[10px] font-bold text-gray-500 shadow-sm transition-colors hover:border-blue-200 hover:bg-blue-50/50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:border-blue-900 dark:hover:bg-blue-900/10 dark:hover:text-blue-400"
              :disabled="isRefreshing || isAnyModelUnloading"
              data-testid="ollama-ps-refresh"
              @click="loadRunningModels"
            >
              <RefreshCwIcon
                class="h-3.5 w-3.5 motion-reduce:animate-none"
                :class="isRefreshing ? 'animate-spin' : ''"
              />
              {{ isRefreshing ? 'Refreshing…' : 'Refresh' }}
            </button>
          </div>

          <div
            v-if="!hasEndpoint"
            class="bg-white px-5 py-8 text-center dark:bg-gray-900/30"
            data-testid="ollama-ps-no-endpoint"
          >
            <p class="text-xs font-bold text-gray-700 dark:text-gray-200">Enter an Ollama endpoint URL to view running models.</p>
          </div>

          <div
            v-else-if="requestState.status === 'idle'"
            class="bg-white px-5 py-8 text-center dark:bg-gray-900/30"
            data-testid="ollama-ps-idle"
          >
            <p class="text-xs font-bold text-gray-700 dark:text-gray-200">Refresh to check this Ollama server.</p>
          </div>

          <div
            v-else-if="requestState.status === 'loading' && models.length === 0"
            class="flex items-center justify-center gap-2 bg-white px-5 py-8 text-[11px] font-bold text-gray-400 dark:bg-gray-900/30"
            aria-busy="true"
            data-testid="ollama-ps-loading"
          >
            <Loader2Icon class="h-4 w-4 animate-spin motion-reduce:animate-none" />
            Loading models…
          </div>

          <div
            v-else-if="requestState.status === 'error' && models.length === 0"
            class="bg-white px-5 py-7 dark:bg-gray-900/30"
            data-testid="ollama-ps-error"
          >
            <div class="mx-auto flex max-w-lg items-start gap-3 rounded-2xl border border-red-100 bg-red-50/40 p-4 dark:border-red-900/30 dark:bg-red-900/10">
              <AlertCircleIcon class="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <div class="min-w-0 flex-1">
                <p class="text-xs font-bold text-red-600 dark:text-red-400">Could not load running models.</p>
                <p class="mt-1 break-words text-[10px] font-medium leading-relaxed text-red-500/80 dark:text-red-300/80">
                  {{ requestState.errorMessage }}
                </p>
              </div>
              <button
                type="button"
                class="shrink-0 rounded-lg px-2 py-1.5 text-[10px] font-bold text-red-600 transition-colors hover:bg-red-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 dark:text-red-400 dark:hover:bg-red-900/20"
                data-testid="ollama-ps-retry"
                @click="loadRunningModels"
              >
                Try Again
              </button>
            </div>
          </div>

          <div
            v-else-if="requestState.status === 'ready' && models.length === 0"
            class="bg-white px-5 py-8 text-center dark:bg-gray-900/30"
            data-testid="ollama-ps-empty"
          >
            <p class="text-xs font-bold text-gray-700 dark:text-gray-200">No models are currently loaded.</p>
            <p class="mt-1 text-[10px] font-medium text-gray-400">Models appear here after Ollama loads them for a request.</p>
          </div>

          <div v-else class="bg-white dark:bg-gray-900/30" :aria-busy="isRefreshing">
            <div
              v-if="requestState.status === 'error'"
              class="flex items-start gap-2 border-b border-red-100 bg-red-50/40 px-4 py-2.5 text-[10px] font-medium leading-relaxed text-red-500 dark:border-red-900/30 dark:bg-red-900/10 dark:text-red-300 sm:px-5"
              aria-live="polite"
              data-testid="ollama-ps-refresh-error"
            >
              <AlertCircleIcon class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {{ requestState.errorMessage }}
            </div>

            <TransitionGroup name="ollama-model-list" tag="ul" class="relative divide-y divide-gray-100 dark:divide-gray-800" data-testid="ollama-model-list">
              <li
                v-for="(model, index) in models"
                :key="`${model.name}:${model.digest ?? ''}`"
                class="bg-white/70 px-4 py-4 transition-opacity duration-200 motion-reduce:transition-none dark:bg-gray-900/35 sm:px-5"
                :class="getModelActionState({ modelName: model.name }) === 'unloading' ? 'opacity-60' : ''"
                :data-testid="`ollama-model-${index}`"
              >
                <div class="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-5">
                  <div class="min-w-0">
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                      <span class="min-w-0 break-all font-mono text-xs font-bold text-gray-800 dark:text-gray-100">
                        {{ model.name }}
                      </span>
                      <span
                        v-if="model.details.parameterSize"
                        class="rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 font-mono text-[9px] font-bold text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
                      >
                        {{ model.details.parameterSize }}
                      </span>
                      <span
                        v-if="model.details.quantizationLevel"
                        class="rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 font-mono text-[9px] font-bold text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
                      >
                        {{ model.details.quantizationLevel }}
                      </span>
                    </div>

                    <div class="mt-2 flex flex-wrap text-[10px] font-medium leading-4 text-gray-400">
                      <span
                        v-for="item in getModelMetadata({ model })"
                        :key="item"
                        class="after:mx-2 after:text-gray-200 after:content-['•'] last:after:hidden dark:after:text-gray-700"
                      >
                        {{ item }}
                      </span>
                    </div>

                    <button
                      v-if="getModelDetails({ model }).length > 0"
                      type="button"
                      class="mt-2 inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-[10px] font-semibold text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                      :aria-expanded="isModelDetailsExpanded({ modelName: model.name })"
                      :aria-controls="`ollama-model-${index}-details`"
                      :data-testid="`ollama-model-${index}-details-toggle`"
                      @click="toggleModelDetails({ modelName: model.name })"
                    >
                      Model details
                      <ChevronDownIcon
                        class="h-3 w-3 transition-transform duration-200 motion-reduce:transition-none"
                        :class="isModelDetailsExpanded({ modelName: model.name }) ? 'rotate-180' : ''"
                      />
                    </button>

                    <div
                      :id="`ollama-model-${index}-details`"
                      class="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
                      :class="isModelDetailsExpanded({ modelName: model.name }) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
                      role="region"
                      :aria-hidden="!isModelDetailsExpanded({ modelName: model.name })"
                      :aria-label="`${model.name} details`"
                      :data-testid="`ollama-model-${index}-details`"
                    >
                      <div class="overflow-hidden">
                        <dl
                          class="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 rounded-xl border border-gray-100 bg-gray-50/70 p-3 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none dark:border-gray-800 dark:bg-gray-950/30 sm:grid-cols-2"
                          :class="isModelDetailsExpanded({ modelName: model.name }) ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'"
                        >
                          <div v-for="item in getModelDetails({ model })" :key="item.label" class="min-w-0">
                            <dt class="text-[8px] font-bold uppercase tracking-widest text-gray-400">{{ item.label }}</dt>
                            <dd class="mt-0.5 break-all font-mono text-[10px] font-semibold text-gray-600 dark:text-gray-300">{{ item.value }}</dd>
                          </div>
                        </dl>
                      </div>
                    </div>

                    <p
                      v-if="modelActionNotices.get(model.name)"
                      class="mt-2 flex items-start gap-1.5 text-[10px] font-medium leading-relaxed text-blue-500 dark:text-blue-400"
                      aria-live="polite"
                      :data-testid="`ollama-model-${index}-notice`"
                    >
                      <Clock3Icon class="mt-0.5 h-3 w-3 shrink-0" />
                      {{ modelActionNotices.get(model.name) }}
                    </p>

                    <p
                      v-if="modelActionErrors.get(model.name)"
                      class="mt-2 flex items-start gap-1.5 text-[10px] font-medium leading-relaxed text-red-500 dark:text-red-400"
                      aria-live="polite"
                      :data-testid="`ollama-model-${index}-error`"
                    >
                      <AlertCircleIcon class="mt-0.5 h-3 w-3 shrink-0" />
                      {{ modelActionErrors.get(model.name) }}
                    </p>
                  </div>

                  <button
                    type="button"
                    class="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-red-100 bg-red-50/40 px-3 py-2 text-[10px] font-bold text-red-500 transition-[background-color,border-color,color,transform] hover:border-red-200 hover:bg-red-50 hover:text-red-600 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:transform-none dark:border-red-900/30 dark:bg-red-900/10 dark:text-red-400 dark:hover:border-red-800 dark:hover:bg-red-900/20 sm:w-auto"
                    :disabled="isRefreshing || isAnyModelUnloading || getModelActionState({ modelName: model.name }) === 'requested'"
                    :data-testid="`ollama-model-${index}-unload`"
                    @click="unloadModel({ model })"
                  >
                    <Loader2Icon
                      v-if="getModelActionState({ modelName: model.name }) === 'unloading'"
                      class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                    />
                    <Clock3Icon
                      v-else-if="getModelActionState({ modelName: model.name }) === 'requested'"
                      class="h-3.5 w-3.5"
                    />
                    <CircleStopIcon v-else class="h-3.5 w-3.5" />
                    {{ getUnloadButtonLabel({ modelName: model.name }) }}
                  </button>
                </div>
              </li>
            </TransitionGroup>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ollama-model-list-enter-active,
.ollama-model-list-leave-active,
.ollama-model-list-move {
  transition: opacity 200ms ease-out, transform 200ms ease-out;
}

.ollama-model-list-enter-from,
.ollama-model-list-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.ollama-model-list-leave-active {
  position: absolute;
  width: 100%;
}

@media (prefers-reduced-motion: reduce) {
  .ollama-model-list-enter-active,
  .ollama-model-list-leave-active,
  .ollama-model-list-move {
    transition: none;
  }

  .ollama-model-list-enter-from,
  .ollama-model-list-leave-to {
    transform: none;
  }
}
</style>
