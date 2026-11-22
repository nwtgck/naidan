<script setup lang="ts">
import { computed, defineAsyncComponent, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { AlertCircleIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ModelMetadataEntry, ModelMetadataValue, ModelWeightDetails } from '@/logic/model-file-inspection/metadata';
import { GGUF_EDITABLE_METADATA_KEYS } from '@/logic/model-file-inspection/gguf-metadata-keys';
import type { FileExplorerModelAccess, ModelWeightOverview } from '@/features/file-explorer/worker/types';
import { useFileExplorerLineNumbers, useFileExplorerTextWrap } from '@/features/file-explorer/composables/useFileExplorerEditorPreferences';
import { formatSize } from '@/features/file-explorer/logic/utils';
import FileExplorerModelTensors from './FileExplorerModelTensors.vue';

const fileExplorerTextWrap = useFileExplorerTextWrap();
const fileExplorerLineNumbers = useFileExplorerLineNumbers();

const EditorV4 = defineAsyncComponent(() => import('@/features/editor-v4/components/EditorV4.vue'));

type SavePlan = { header: Uint8Array<ArrayBuffer>, bodyOffset: number };
type Panel = 'overview' | 'metadata' | 'tensors' | 'tokenizer';
type Draft = { original: string | undefined, text: string };

const props = defineProps<{ file: Blob, access: FileExplorerModelAccess, canSave: boolean, saving?: boolean, compact?: boolean }>();
const emit = defineEmits<{
  (event: 'save', plan: SavePlan): void,
  (event: 'dirtyChange', change: { dirty: boolean }): void,
}>();

const details = shallowRef<ModelWeightDetails>();
const overview = shallowRef<ModelWeightOverview>();
const model = computed(() => overview.value ?? details.value);
const modelError = ref<string>();
const detailsError = ref<string>();
const panel = ref<Panel>('overview');
const modelFormat = computed(() => {
  const format = model.value?.format;
  switch (format) {
  case 'gguf': return { label: 'GGUF', hasTokenizer: true };
  case 'safetensors': return { label: 'Safetensors', hasTokenizer: false };
  case undefined: return undefined;
  default: {
    const exhaustive: never = format;
    throw new Error(`Unhandled model format: ${String(exhaustive)}`);
  }
  }
});
const panelOptions = computed<{ id: Panel, label: string | undefined }[]>(() => {
  const options: { id: Panel, label: string | undefined }[] = [
    { id: 'overview', label: lazyStrings.FileExplorerModelView__overview() },
    { id: 'metadata', label: lazyStrings.FileExplorerModelView__metadata() },
    { id: 'tensors', label: lazyStrings.FileExplorerModelView__tensors() },
  ];
  if (modelFormat.value?.hasTokenizer) {
    options.push({ id: 'tokenizer', label: lazyStrings.FileExplorerModelView__tokenizer() });
  }
  return options;
});
const filter = ref('');
const tablePage = ref(0);
const selectedKey = ref<string>();
const valueStarts = ref([0]);
const metadataValue = shallowRef<{ values: ModelMetadataValue[], next: number | undefined }>();
const valueLoading = ref(false);
const valueError = ref<string>();
const copyStatus = ref<'copied' | 'failed'>();
const drafts = ref(new Map<string, Draft>());
const saveError = ref<string>();
const saveController = shallowRef<AbortController>();
const tablePageSize = 40;
const valuePageSize = 16;
const editableKeys: ReadonlySet<string> = new Set(GGUF_EDITABLE_METADATA_KEYS);

const locked = computed(() => !props.canSave || props.saving === true || saveController.value !== undefined);
const dirty = computed(() => Array.from(drafts.value.values()).some(draft => draft.text !== (draft.original ?? '')));
watch(dirty, value => emit('dirtyChange', { dirty: value }), { flush: 'sync' });

function discardChanges(): void {
  drafts.value.clear();
  saveError.value = undefined;
}

watch([() => props.file, () => props.access, () => props.compact], async ([file, access, compact], _previous, onCleanup) => {
  saveController.value?.abort();
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  overview.value = undefined;
  details.value = undefined;
  modelError.value = undefined;
  detailsError.value = undefined;
  selectedKey.value = undefined;
  discardChanges();
  if (compact) {
    panel.value = 'overview';
  }

  try {
    const request = { file, signal: controller.signal };
    const result = compact ? await access.inspectModelOverview(request) : await access.inspectModel(request);
    if (controller.signal.aborted) {
      return;
    }
    switch (result.status) {
    case 'weights':
      if ('tensors' in result.value) {
        details.value = result.value;
      } else {
        overview.value = result.value;
      }
      if (result.value.format !== 'gguf' && panel.value === 'tokenizer') {
        panel.value = 'overview';
      }
      break;
    case 'unknown':
    case 'invalid':
    case 'lfs-pointer':
      modelError.value = result.reason;
      break;
    default: {
      const exhaustive: never = result;
      throw new Error(String(exhaustive));
    }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      modelError.value = error instanceof Error ? error.message : String(error);
    }
  }
}, { immediate: true });

watch([overview, () => panel.value !== 'overview'], async ([summary, showDetails], _previous, onCleanup) => {
  if (summary === undefined || !showDetails || details.value !== undefined) {
    return;
  }
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  detailsError.value = undefined;
  try {
    const result = await props.access.inspectModel({ file: props.file, signal: controller.signal });
    if (controller.signal.aborted) {
      return;
    }
    switch (result.status) {
    case 'weights':
      details.value = result.value;
      break;
    case 'unknown': case 'invalid': case 'lfs-pointer':
      detailsError.value = result.reason;
      break;
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled model inspection: ${String(exhaustive)}`);
    }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      detailsError.value = error instanceof Error ? error.message : String(error);
    }
  }
});

onScopeDispose(() => saveController.value?.abort());

const actualMetadata = computed(() => details.value?.metadata ?? []);
const modelName = computed(() => overview.value?.name ?? actualMetadata.value.find(entry => entry.key === 'general.name')?.value);
const architecture = computed(() => overview.value?.architecture ?? actualMetadata.value.find(entry => entry.key === 'general.architecture')?.value);
const overviewRows = computed(() => {
  const inspected = model.value;
  if (inspected === undefined) {
    return [];
  }
  return [
    { id: 'format', label: lazyStrings.fileExplorer__type(), value: modelFormat.value?.label },
    { id: 'name', label: lazyStrings.fileExplorer__name(), value: modelName.value },
    { id: 'architecture', label: lazyStrings.FileExplorerModelView__architecture(), value: architecture.value },
    { id: 'version', label: lazyStrings.FileExplorerModelView__gguf_version(), value: inspected.version },
    { id: 'size', label: lazyStrings.fileExplorer__size(), value: formatSize({ bytes: props.file.size }) },
    { id: 'shard', label: lazyStrings.FileExplorerModelView__shard(), value: inspected.split === undefined ? undefined : `${inspected.split.index + 1} / ${inspected.split.count}` },
    { id: 'metadata', label: lazyStrings.FileExplorerModelView__metadata(), value: (overview.value?.metadataCount ?? actualMetadata.value.length).toLocaleString() },
    { id: 'tensors', label: lazyStrings.FileExplorerModelView__tensors(), value: (overview.value?.tensorCount ?? details.value?.tensors.length ?? 0).toLocaleString() },
  ].filter(row => row.value !== undefined);
});
const metadata = computed<readonly ModelMetadataEntry[]>(() => {
  const entries = actualMetadata.value;
  if (details.value?.format !== 'gguf' || !props.canSave) {
    return entries;
  }
  const present = new Set(entries.filter(entry => editableKeys.has(entry.key)).map(entry => entry.key));
  return [
    ...entries,
    ...GGUF_EDITABLE_METADATA_KEYS.filter(key => !present.has(key)).map(key => ({
      key,
      type: 'string',
      value: undefined,
      count: undefined,
      elementType: undefined,
      range: undefined,
    })),
  ];
});
const matches = computed(() => {
  const query = filter.value.trim().toLowerCase();
  if (query === '' && panel.value !== 'tokenizer') {
    return metadata.value;
  }
  return metadata.value.filter(entry => {
    if (panel.value === 'tokenizer' && !entry.key.startsWith('tokenizer.')) {
      return false;
    }
    return entry.key.toLowerCase().includes(query)
      || entry.type.toLowerCase().includes(query)
      || String(entry.value ?? '').toLowerCase().includes(query);
  });
});
const tableLastPage = computed(() => Math.max(0, Math.ceil(matches.value.length / tablePageSize) - 1));
const tableRows = computed(() => matches.value.slice(tablePage.value * tablePageSize, (tablePage.value + 1) * tablePageSize));
const selected = computed(() => metadata.value.find(entry => entry.key === selectedKey.value));
const selectedDraft = computed(() => selectedKey.value === undefined ? undefined : drafts.value.get(selectedKey.value));
const selectedIsEditable = computed(() => (
  details.value?.format === 'gguf' && selected.value?.type === 'string' && editableKeys.has(selected.value.key)
));
const valueStart = computed(() => valueStarts.value.at(-1) ?? 0);
const scalarValue = computed(() => selected.value?.count === undefined ? metadataValue.value?.values[0] : undefined);

watch([filter, panel], () => {
  tablePage.value = 0;
});
watch(tableLastPage, limit => {
  tablePage.value = Math.min(tablePage.value, limit);
});
watch([selected, valueStart], async ([entry, start], _previous, onCleanup) => {
  metadataValue.value = undefined;
  valueLoading.value = false;
  valueError.value = undefined;
  copyStatus.value = undefined;
  if (!entry) {
    return;
  }

  if (entry.count === undefined && entry.value !== undefined) {
    metadataValue.value = { values: [entry.value], next: undefined };
    return;
  }
  if (entry.range === undefined || entry.count === 0) {
    return;
  }

  const controller = new AbortController();
  onCleanup(() => controller.abort());
  valueLoading.value = true;
  try {
    const result = await props.access.readModelMetadataValue({
      file: props.file,
      entry,
      start,
      limit: entry.count === undefined ? 1 : valuePageSize,
      signal: controller.signal,
    });
    if (!controller.signal.aborted) {
      metadataValue.value = result;
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      valueError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (!controller.signal.aborted) {
      valueLoading.value = false;
    }
  }
});

function selectPanel({ next }: { next: Panel }): void {
  panel.value = next;
  if (next === 'tokenizer' && !selectedKey.value?.startsWith('tokenizer.')) {
    selectedKey.value = undefined;
  }
}

function selectMetadata({ key }: { key: string }): void {
  selectedKey.value = key;
  valueStarts.value = [0];
}

function nextValuePage(): void {
  const next = metadataValue.value?.next;
  if (next !== undefined) {
    valueStarts.value.push(next);
  }
}

function editSelected(): void {
  const key = selectedKey.value;
  if (!key || locked.value || !selectedIsEditable.value || valueLoading.value || valueError.value !== undefined) {
    return;
  }
  const original = typeof scalarValue.value === 'string' ? scalarValue.value : undefined;
  drafts.value.set(key, { original, text: original ?? '' });
}

function updateDraft({ text }: { text: string }): void {
  if (selectedDraft.value && !locked.value) {
    selectedDraft.value.text = text;
  }
}

function updateDraftInput({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement) {
    updateDraft({ text: event.target.value });
  }
}

function cancelSelectedEdit(): void {
  const key = selectedKey.value;
  if (key !== undefined && !saveController.value && !props.saving) {
    drafts.value.delete(key);
  }
}

function formatValuePreview({ entry }: { entry: ModelMetadataEntry }): string {
  const value = drafts.value.get(entry.key)?.text ?? entry.value;
  if (value === undefined) {
    return '—';
  }
  const string = String(value);
  return string.length > 120 ? `${string.slice(0, 120)}…` : string;
}

async function copyScalar(): Promise<void> {
  const key = selectedKey.value;
  const value = scalarValue.value;
  if (value === undefined) {
    return;
  }
  try {
    await navigator.clipboard.writeText(String(value));
    if (key === selectedKey.value) {
      copyStatus.value = 'copied';
    }
  } catch {
    if (key === selectedKey.value) {
      copyStatus.value = 'failed';
    }
  }
}

async function requestSave(): Promise<SavePlan | undefined> {
  if (locked.value || !dirty.value || details.value?.format !== 'gguf') {
    return undefined;
  }
  const controller = new AbortController();
  const changes = Object.fromEntries(Array.from(drafts.value)
    .filter(([, draft]) => draft.text !== (draft.original ?? ''))
    .map(([key, draft]) => [key, draft.text]));
  saveController.value = controller;
  saveError.value = undefined;
  try {
    const plan = await props.access.prepareGgufMetadataRewrite({ file: props.file, changes, signal: controller.signal });
    return controller.signal.aborted ? undefined : plan;
  } catch (error) {
    if (!controller.signal.aborted) {
      saveError.value = error instanceof Error ? error.message : String(error);
    }
    return undefined;
  } finally {
    if (saveController.value === controller) {
      saveController.value = undefined;
    }
  }
}

async function saveChanges(): Promise<void> {
  const plan = await requestSave();
  if (plan) {
    emit('save', plan);
  }
}

defineExpose({
  requestSave,
  markSaved: discardChanges,
  discardChanges,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="flex min-h-0 flex-1 flex-col overflow-hidden text-gray-800 dark:text-gray-200" data-testid="model-file-view">
    <div v-if="modelError !== undefined" role="alert" tw-class="m-3 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-xs dark:bg-red-950">
      <AlertCircleIcon tw-class="h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
      <div tw-class="min-w-0">
        <p>{{ lazyStrings.FileExplorerModelView__failed_to_read_model() }}</p>
        <p tw-class="break-words text-xs text-gray-600 dark:text-gray-400">{{ modelError }}</p>
      </div>
    </div>
    <div v-else-if="!model" role="status" aria-busy="true" tw-class="flex flex-1 items-center justify-center">
      <Loader2Icon tw-class="h-5 w-5 animate-spin text-gray-500" />
    </div>
    <template v-else>
      <nav tw-class="flex shrink-0 flex-wrap gap-1 border-b border-gray-100 bg-gray-50 px-3 py-1.5 dark:border-gray-800 dark:bg-gray-900/50">
        <button
          v-for="option in panelOptions"
          :key="option.id"
          type="button"
          :aria-pressed="panel === option.id"
          :data-testid="`model-${option.id}-tab`"
          :tw-class="['rounded-lg px-2 py-1 text-xs transition-colors', panel === option.id
            ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-900/20 dark:text-blue-400'
            : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800']"
          @click="selectPanel({ next: option.id })"
        >{{ option.label }}</button>
      </nav>

      <div v-if="model.format === 'gguf' && dirty" tw-class="flex shrink-0 items-center gap-3 border-b border-gray-100 px-3 py-2 dark:border-gray-800">
        <button
          type="button"
          :disabled="locked"
          data-testid="model-metadata-save"
          tw-class="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-40"
          @click="saveChanges"
        >{{ lazyStrings.FileExplorerModelView__review_and_save() }}</button>
        <p v-if="saveError" role="alert" tw-class="min-w-0 break-words text-xs text-red-700 dark:text-red-300">
          {{ lazyStrings.FileExplorerModelView__failed_to_prepare_metadata_changes() }} {{ saveError }}
        </p>
      </div>

      <dl v-if="panel === 'overview'" tw-class="min-h-0 overflow-auto text-xs" data-testid="model-overview">
        <div
          v-for="row in overviewRows"
          :key="row.id"
          tw-class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 border-b border-gray-100 px-3 py-2 last:border-0 dark:border-gray-800"
        >
          <dt tw-class="wrap-anywhere text-gray-500 dark:text-gray-400">{{ row.label }}</dt>
          <dd tw-class="wrap-anywhere font-medium text-gray-700 dark:text-gray-300">{{ row.value }}</dd>
        </div>
      </dl>
      <p v-else-if="detailsError !== undefined" role="alert" tw-class="m-3 break-words rounded-lg bg-red-50 p-3 text-xs dark:bg-red-950">
        {{ lazyStrings.FileExplorerModelView__failed_to_read_model() }} {{ detailsError }}
      </p>
      <div v-else-if="!details" role="status" aria-busy="true" tw-class="flex flex-1 items-center justify-center">
        <Loader2Icon tw-class="h-5 w-5 animate-spin text-gray-500" />
      </div>
      <FileExplorerModelTensors v-else-if="panel === 'tensors'" :tensors="details.tensors" :compact="compact" />
      <div v-else tw-class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3" data-testid="model-metadata">
        <div tw-class="flex shrink-0 flex-wrap items-center gap-3">
          <input
            v-model="filter"
            type="search"
            data-testid="model-metadata-search"
            :aria-label="lazyStrings.fileExplorer__search()"
            :placeholder="lazyStrings.fileExplorer__search()"
            tw-class="min-w-0 max-w-sm flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900"
          />
          <div v-if="tableLastPage > 0" tw-class="flex items-center gap-2 text-xs">
            <button
              type="button"
              :disabled="tablePage === 0"
              data-testid="model-metadata-previous"
              tw-class="rounded-md px-2 py-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
              @click="tablePage -= 1"
            >{{ lazyStrings.FileExplorerModelView__previous_page() }}</button>
            <span>{{ tablePage + 1 }} / {{ tableLastPage + 1 }}</span>
            <button
              type="button"
              :disabled="tablePage >= tableLastPage"
              data-testid="model-metadata-next"
              tw-class="rounded-md px-2 py-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
              @click="tablePage += 1"
            >{{ lazyStrings.FileExplorerModelView__next_page() }}</button>
          </div>
        </div>

        <section v-if="selected" tw-class="shrink-0 space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-800" data-testid="model-metadata-value">
          <div tw-class="flex flex-wrap items-center gap-2">
            <h3 tw-class="min-w-0 flex-1 break-all font-mono text-sm font-medium">{{ selected.key }}</h3>
            <button
              v-if="scalarValue !== undefined && !selectedDraft"
              type="button"
              tw-class="rounded-md px-2 py-1 text-xs hover:bg-gray-100 dark:hover:bg-gray-800"
              @click="copyScalar"
            >{{ lazyStrings.FileExplorerModelView__copy_value() }}</button>
            <button
              v-if="!compact && selectedIsEditable && !selectedDraft"
              type="button"
              data-testid="model-metadata-edit"
              :disabled="locked || valueLoading || valueError !== undefined"
              :title="!props.canSave ? lazyStrings.fileExplorer__read_only() : undefined"
              tw-class="rounded-md px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
              @click="editSelected"
            >{{ lazyStrings.FileExplorerModelView__edit_value() }}</button>
            <button
              v-if="selectedDraft"
              type="button"
              :disabled="props.saving || saveController !== undefined"
              tw-class="rounded-md px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
              @click="cancelSelectedEdit"
            >{{ lazyStrings.SHARED__cancel() }}</button>
          </div>
          <p v-if="copyStatus === 'copied'" role="status" tw-class="text-xs">{{ lazyStrings.FileExplorerModelView__copied() }}</p>
          <p v-else-if="copyStatus === 'failed'" role="status" tw-class="text-xs text-red-700 dark:text-red-300">{{ lazyStrings.FileExplorerModelView__failed_to_copy_value() }}</p>
          <div v-if="selectedDraft">
            <div v-if="selected.key === 'tokenizer.chat_template'" tw-class="flex h-64 flex-col overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
              <EditorV4
                :key="selected.key"
                v-model:word-wrap="fileExplorerTextWrap"
                v-model:line-numbers="fileExplorerLineNumbers"
                :initial-text="selectedDraft.text"
                :read-only="locked"
                @change="updateDraft"
                @request-save="saveChanges"
              />
            </div>
            <input
              v-else
              type="text"
              :value="selectedDraft.text"
              :aria-label="selected.key"
              :readonly="locked"
              data-testid="model-metadata-input"
              tw-class="w-full rounded-md border border-gray-200 bg-white px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900"
              @input="updateDraftInput({ event: $event })"
            />
            <details v-if="selectedDraft.original !== undefined" tw-class="mt-2 text-xs">
              <summary tw-class="cursor-pointer text-gray-600 dark:text-gray-400">{{ lazyStrings.FileExplorerModelView__original_value() }}</summary>
              <pre tw-class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 dark:bg-gray-900">{{ selectedDraft.original }}</pre>
            </details>
          </div>
          <p v-else-if="valueError !== undefined" role="alert" tw-class="break-words text-xs text-red-700 dark:text-red-300">
            {{ lazyStrings.FileExplorerModelView__failed_to_read_metadata_value() }} {{ valueError }}
          </p>
          <Loader2Icon v-else-if="valueLoading" role="status" aria-busy="true" tw-class="h-4 w-4 animate-spin text-gray-500" />
          <pre v-else-if="scalarValue !== undefined" tw-class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 font-mono text-xs dark:bg-gray-900" data-testid="model-metadata-scalar">{{ scalarValue }}</pre>
          <div v-else-if="selected.count !== undefined" tw-class="space-y-2">
            <p tw-class="font-mono text-xs text-gray-500">{{ selected.elementType }} [{{ selected.count }}]</p>
            <ol v-if="metadataValue" :start="valueStart + 1" tw-class="max-h-64 list-decimal overflow-auto rounded-md bg-gray-50 py-2 pl-12 pr-2 font-mono text-xs dark:bg-gray-900">
              <li v-for="(value, index) in metadataValue.values" :key="valueStart + index" tw-class="whitespace-pre-wrap break-words py-0.5">{{ value }}</li>
            </ol>
            <div v-if="valueStarts.length > 1 || metadataValue?.next !== undefined" tw-class="flex items-center gap-2 text-xs">
              <button type="button" :disabled="valueStarts.length <= 1" tw-class="rounded-md px-2 py-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800" @click="valueStarts.pop()">{{ lazyStrings.FileExplorerModelView__previous_page() }}</button>
              <button type="button" :disabled="metadataValue?.next === undefined" data-testid="model-metadata-value-next" tw-class="rounded-md px-2 py-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800" @click="nextValuePage">{{ lazyStrings.FileExplorerModelView__next_page() }}</button>
            </div>
          </div>
          <p v-else tw-class="text-xs text-gray-500">{{ lazyStrings.FileExplorerModelView__value_is_not_set() }}</p>
        </section>

        <div v-if="tableRows.length !== 0" tw-class="min-h-56 grow overflow-auto rounded-md border border-gray-200 dark:border-gray-800">
          <table :tw-class="['w-full text-left text-xs', compact && 'table-fixed']">
            <thead v-if="!compact" tw-class="sticky top-0 bg-gray-50 dark:bg-gray-900">
              <tr>
                <th scope="col" tw-class="px-3 py-2 font-medium">{{ lazyStrings.fileExplorer__name() }}</th>
                <th scope="col" tw-class="px-3 py-2 font-medium">{{ lazyStrings.fileExplorer__type() }}</th>
                <th scope="col" tw-class="px-3 py-2 font-medium">{{ lazyStrings.FileExplorerModelView__value() }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in tableRows" :key="entry.key" tw-class="border-t border-gray-100 dark:border-gray-800">
                <td :tw-class="['px-2 py-1', !compact && 'max-w-56']">
                  <button
                    type="button"
                    :aria-pressed="selectedKey === entry.key"
                    data-testid="model-metadata-key"
                    :tw-class="['max-w-full rounded-lg px-1 py-1 text-left font-mono text-gray-700 hover:bg-gray-100 aria-pressed:bg-blue-50 aria-pressed:text-blue-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:aria-pressed:bg-blue-900/20 dark:aria-pressed:text-blue-400', compact ? 'w-full wrap-anywhere' : 'truncate']"
                    @click="selectMetadata({ key: entry.key })"
                  >
                    <span>{{ entry.key }}</span>
                    <span v-if="compact" tw-class="block truncate text-gray-500 dark:text-gray-400">
                      {{ entry.count === undefined ? entry.type : `${entry.elementType} [${entry.count}]` }} · {{ formatValuePreview({ entry }) }}
                    </span>
                  </button>
                </td>
                <td v-if="!compact" tw-class="whitespace-nowrap px-3 py-2 font-mono text-gray-500 dark:text-gray-400">
                  <template v-if="entry.count !== undefined">{{ entry.elementType }} [{{ entry.count }}]</template>
                  <template v-else>{{ entry.type }}</template>
                </td>
                <td v-if="!compact" tw-class="max-w-48 truncate px-3 py-2 font-mono">{{ formatValuePreview({ entry }) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else tw-class="px-3 py-2 text-xs text-gray-500">{{ lazyStrings.fileExplorer__no_matching_items() }}</p>
      </div>
    </template>
  </div>
</template>
