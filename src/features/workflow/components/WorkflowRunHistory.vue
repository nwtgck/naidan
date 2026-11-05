<script setup lang="ts">
import { computed, ref, shallowRef, watch, onBeforeUnmount } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { HistoryIcon, CopyIcon, FolderOpenIcon, DownloadIcon, RefreshCwIcon, Trash2Icon, ArrowLeftIcon, AlertTriangleIcon } from 'lucide-vue-next';
import type { WorkflowRunId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { createWorkflowRunStore, type WorkflowRunSnapshot, type WorkflowRunActivity } from '@/00-storage/service/workflow-run';
import { formatWorkflowDefinition } from '@/00-storage/service/workflow-json';
import { useConfirm } from '@/composables/useConfirm';
import { getOPFSTmpManager } from '@/logic/opfs-tmp-manager';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { downloadFile } from '@/utils/stream-download';
import { ensureStrings, lazyStrings } from '@/strings';
import { useWorkflowWorkspace } from '@/features/workflow/composables/use-workflow-workspace';
import { workflowRunPath } from '@/features/workflow/logic/locations';
import { openWorkflowHistoryResults } from '@/features/workflow/logic/history-results';
import { zipWorkflowFolder, clearWorkflowStagingDirectory } from '@/features/workflow/logic/files';
import { flatWorkflowSteps } from '@/features/workflow/logic/editor';
import { workflowStepLabel } from '@/features/workflow/logic/forms';
import WorkflowResultGallery from './WorkflowResultGallery.vue';
import { archivedWorkflowResultSources, type WorkflowResultSource } from '@/features/workflow/logic/result-view';
import WorkflowDisclosure from './WorkflowDisclosure.vue';

const props = defineProps<{ runId: WorkflowRunId | undefined }>();
const workspace = useWorkflowWorkspace();
const router = useRouter();
const { showConfirm } = useConfirm();
const snapshot = shallowRef<WorkflowRunSnapshot>();
const activity = ref<WorkflowRunActivity>();
const error = ref(''), loading = ref(false), busy = ref(false), resultsMissing = ref(false);
const visibleCount = ref(50);
const resultSources = shallowRef<WorkflowResultSource[]>([]);
let request = 0;
let actionController = new AbortController();
let zipCache: { runId: WorkflowRunId, file: File } | undefined;
const isLive = computed(() => props.runId !== undefined && props.runId === workspace.activeRunId.value && (workspace.running.value || workspace.historySavePending.value));
const entries = computed(() => isLive.value ? workspace.log.value : snapshot.value?.record.entries ?? []);
const steps = computed(() => snapshot.value ? flatWorkflowSteps({ steps: snapshot.value.record.definition.steps }) : []);
const definitionText = computed(() => snapshot.value ? formatWorkflowDefinition({ definition: snapshot.value.record.definition }) : '');
const status = computed(() => {
  if (isLive.value) {
    return workspace.historySavePending.value ? lazyStrings.workflow__run_is_active_or_awaiting_save()
      : workspace.finalizing.value ? lazyStrings.workflow__finalizing_history()
        : workspace.pending.value ? lazyStrings.workflow__waiting() : lazyStrings.workflow__running();
  }
  const value = snapshot.value?.record.status;
  switch (value) {
  case 'completed': return lazyStrings.workflow__completed();
  case 'failed': return lazyStrings.workflow__failed();
  case 'cancelled': return lazyStrings.workflow__cancelled();
  case 'interrupted': return lazyStrings.workflow__interrupted();
  case 'running': {
    switch (activity.value) {
    case 'active': return lazyStrings.workflow__run_is_active_or_awaiting_save();
    case undefined: case 'recoverable': case 'unverifiable': case 'finished': return lazyStrings.workflow__unfinished_run();
    default: {
      const exhaustive: never = activity.value;
      return exhaustive;
    }
    }
  }
  case undefined: return '';
  default: {
    const exhaustive: never = value;
    return exhaustive;
  }
  }
});

const activityNotice = computed(() => {
  switch (activity.value) {
  case 'active': return lazyStrings.workflow__run_is_active_or_awaiting_save();
  case 'recoverable': return lazyStrings.workflow__run_has_no_active_owner();
  case undefined: case 'unverifiable': return lazyStrings.workflow__run_activity_cannot_be_verified();
  case 'finished': return undefined;
  default: {
    const exhaustive: never = activity.value;
    return exhaustive;
  }
  }
});

async function load(): Promise<void> {
  const token = ++request, id = props.runId;
  actionController.abort();
  actionController = new AbortController();
  // Successfully dispatched Blob downloads can still read their OPFS backing.
  // Release only this cache reference; the temporary owner controls file cleanup.
  zipCache = undefined;
  snapshot.value = undefined;
  activity.value = undefined;
  resultsMissing.value = false;
  resultSources.value = [];
  error.value = '';
  loading.value = true;
  try {
    if (id === undefined) {
      await workspace.refreshRuns();
    } else {
      const store = createWorkflowRunStore({ storageType: storageService.getCurrentType() });
      const loaded = await store.load({ id });
      if (request !== token) {
        return;
      }
      // A failed liveness check must not hide a readable snapshot or imply that
      // the owner is gone. Mutation rechecks ownership and the exact file bytes.
      snapshot.value = loaded;
      const checked = await store.activity({ previous: loaded });
      if (request === token) {
        activity.value = checked;
      }
    }
  } catch (reason) {
    if (request === token) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (request === token) {
      loading.value = false;
    }
  }
}

watch(() => props.runId, () => {
  void load();
}, { immediate: true });
watch(() => [workspace.running.value, workspace.historySavePending.value] as const, ([running]) => {
  if (!running) {
    void load();
  }
});
onBeforeUnmount(() => {
  request++;
  actionController.abort();
});

async function copySnapshot(): Promise<void> {
  const selected = snapshot.value;
  if (!selected || busy.value) {
    return;
  }
  busy.value = true;
  try {
    const token = request;
    if (await workspace.copyRun({ snapshot: selected, canApply: () => token === request })) {
      await router.push('/workflows');
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    busy.value = false;
  }
}

async function removeRecord(): Promise<void> {
  const selected = snapshot.value;
  if (!selected || busy.value || isLive.value || selected.record.status === 'running') {
    return;
  }
  busy.value = true;
  const token = request;
  try {
    if (!await showConfirm({ message: await ensureStrings.workflow__delete_run_history(), confirmButtonVariant: 'danger' }) || token !== request) {
      return;
    }
    await createWorkflowRunStore({ storageType: storageService.getCurrentType() }).remove({ previous: selected });
    await workspace.refreshRuns();
    if (token === request) {
      await router.push('/workflows/runs');
    }
  } catch (reason) {
    if (token === request) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    busy.value = false;
  }
}

async function markInterrupted(): Promise<void> {
  const selected = snapshot.value, token = request;
  if (!selected || busy.value || isLive.value || selected.record.status !== 'running' || activity.value !== 'recoverable') {
    return;
  }
  busy.value = true;
  try {
    const message = await ensureStrings.workflow__mark_interrupted_notice();
    if (token !== request || !await showConfirm({ message, confirmButtonVariant: 'danger' }) || token !== request) {
      return;
    }
    const updated = await createWorkflowRunStore({ storageType: storageService.getCurrentType() }).interrupt({ previous: selected });
    if (token === request) {
      snapshot.value = updated;
      activity.value = 'finished';
    }
    await workspace.refreshRuns();
  } catch (reason) {
    if (token === request) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    busy.value = false;
  }
}

async function viewResults(): Promise<void> {
  const selected = snapshot.value, signal = actionController.signal, token = request;
  if (!selected?.record.resultsPath || busy.value) {
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const directory = await openWorkflowHistoryResults({ root: await navigator.storage.getDirectory(), path: selected.record.resultsPath });
    signal.throwIfAborted();
    if (!directory) {
      resultsMissing.value = true;
      return;
    }
    const sources = await archivedWorkflowResultSources({ directory, signal });
    if (token === request && !signal.aborted) {
      resultSources.value = sources;
    }
  } catch (reason) {
    if (token === request && !signal.aborted) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (token === request) {
      busy.value = false;
    }
  }
}

async function openResults({ zip }: { zip: boolean }): Promise<void> {
  const selected = snapshot.value, signal = actionController.signal;
  if (!selected?.record.resultsPath || busy.value) {
    return;
  }
  busy.value = true;
  let zipDirectory: FileSystemDirectoryHandle | undefined;
  let downloadDispatched = false;
  try {
    const directory = await openWorkflowHistoryResults({ root: await navigator.storage.getDirectory(), path: selected.record.resultsPath });
    signal.throwIfAborted();
    if (!directory) {
      resultsMissing.value = true;
      return;
    }
    if (zip) {
      let file = zipCache?.runId === selected.record.id ? zipCache.file : undefined;
      if (!file) {
        zipDirectory = await getOPFSTmpManager().createTmpDirectory({ prefix: 'workflow-history-zip' });
        file = await zipWorkflowFolder({ directory, zipDirectory, signal });
      }
      signal.throwIfAborted();
      await downloadFile({ file, filename: 'workflow-results.zip', signal });
      // downloadFile resolves on stream EOF or Blob-link dispatch, not a durable
      // browser save. Keep successful archives until the tmp owner's lifecycle.
      downloadDispatched = true;
      if (!signal.aborted && props.runId === selected.record.id) {
        zipCache = { runId: selected.record.id, file };
      }
    } else {
      const title = await ensureStrings.workflow__results();
      signal.throwIfAborted();
      useFileExplorerModal().openFileExplorer({ options: { kind: 'native-directory', title, rootName: 'workflow-results', handle: directory, readOnly: true, initialPath: undefined } });
    }
  } catch (reason) {
    if (!signal.aborted) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (zipDirectory && !downloadDispatched) {
      await clearWorkflowStagingDirectory({ directory: zipDirectory }).catch(() => undefined);
    }
    busy.value = false;
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <main tw-class="flex-1 min-h-0 overflow-y-auto bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100" data-testid="workflow-history">
    <div tw-class="mx-auto max-w-5xl p-4 md:p-8 space-y-5">
      <header tw-class="flex flex-wrap items-center gap-3">
        <HistoryIcon tw-class="w-5 h-5 text-blue-500" /><h1 tw-class="text-lg font-semibold flex-1">{{ lazyStrings.workflow__run_history() }}</h1>
        <RouterLink to="/workflows" tw-class="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"><ArrowLeftIcon tw-class="h-4 w-4" />{{ lazyStrings.workflow__back_to_editor() }}</RouterLink>
        <button type="button" @click="load" data-testid="workflow-history-refresh" :disabled="loading || busy" :aria-label="lazyStrings.workflow__refresh()" tw-class="rounded-xl p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><RefreshCwIcon :tw-class="['w-4 h-4', loading && 'motion-safe:animate-spin']" /></button>
      </header>
      <p tw-class="text-xs text-gray-500 leading-relaxed">{{ lazyStrings.workflow__temporary_results_notice() }}</p>
      <p v-if="error" role="alert" tw-class="rounded-xl bg-red-50 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300 break-words">{{ error }}</p>
      <p v-if="loading" role="status" tw-class="py-8 text-sm text-gray-500">{{ lazyStrings.workflow__loading() }}</p>
      <template v-else-if="!runId">
        <p v-if="workspace.historyError.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ workspace.historyError.value }}</p>
        <p v-if="workspace.runs.value.unreadable.length" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ lazyStrings.workflow__unreadable_history() }}</p>
        <p v-if="!workspace.runs.value.items.length" tw-class="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-8 text-sm text-gray-500 text-center">{{ lazyStrings.workflow__no_run_history() }}</p>
        <ul tw-class="space-y-2">
          <li v-for="item in workspace.runs.value.items.slice(0, visibleCount)" :key="idToRaw({ id: item.id })">
            <RouterLink :to="workflowRunPath({ id: item.id })" tw-class="flex items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 hover:border-blue-400 hover:bg-blue-50/40 dark:hover:bg-blue-950/20 focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
              <span tw-class="min-w-0"><strong tw-class="block truncate text-sm">{{ item.name }}</strong><time tw-class="block text-xs text-gray-500 mt-1">{{ new Date(item.startedAt).toLocaleString() }}</time></span>
              <span tw-class="text-xs text-gray-500 shrink-0">{{ item.status === 'completed' ? lazyStrings.workflow__completed() : item.status === 'failed' ? lazyStrings.workflow__failed() : item.status === 'cancelled' ? lazyStrings.workflow__cancelled() : item.status === 'interrupted' ? lazyStrings.workflow__interrupted() : lazyStrings.workflow__unfinished_run() }}</span>
            </RouterLink>
          </li>
        </ul>
        <button v-if="workspace.runs.value.items.length > visibleCount" type="button" @click="visibleCount += 50" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800">{{ lazyStrings.workflow__continue() }} · {{ visibleCount }} / {{ workspace.runs.value.items.length }}</button>
      </template>
      <template v-else-if="snapshot">
        <section tw-class="rounded-2xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/30 p-4 md:p-5 space-y-4">
          <div tw-class="flex flex-wrap items-start gap-3"><div tw-class="flex-1 min-w-0"><h2 tw-class="text-lg font-semibold break-words">{{ snapshot.record.definition.name }}</h2><time tw-class="text-xs text-gray-500">{{ new Date(snapshot.record.startedAt).toLocaleString() }}</time></div><span role="status" :tw-class="['text-xs font-medium rounded-full px-3 py-1', isLive ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 motion-safe:animate-pulse' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300']">{{ status }}</span></div>
          <p v-if="snapshot.record.status === 'running' && !isLive" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ activityNotice }}</p>
          <p v-if="snapshot.record.status === 'interrupted'" tw-class="text-xs text-amber-700 dark:text-amber-400" data-testid="workflow-interrupted-notice">{{ lazyStrings.workflow__interrupted_run_notice() }}</p>
          <p v-if="snapshot.record.checkpointAt !== undefined" tw-class="text-xs text-gray-500" data-testid="workflow-checkpoint-time">{{ lazyStrings.workflow__last_saved_progress() }} · <time>{{ new Date(snapshot.record.checkpointAt).toLocaleString() }}</time></p>
          <p v-if="snapshot.record.status === 'interrupted' && snapshot.record.finishedAt !== undefined" tw-class="text-xs text-gray-500">{{ lazyStrings.workflow__interruption_recorded_at() }} · <time>{{ new Date(snapshot.record.finishedAt).toLocaleString() }}</time></p>
          <p v-if="isLive && workspace.pending.value" tw-class="text-sm text-blue-600 dark:text-blue-400">{{ workspace.pending.value.title }} · <RouterLink to="/workflows" tw-class="underline underline-offset-2">{{ lazyStrings.workflow__back_to_editor() }}</RouterLink></p>
          <p v-if="snapshot.record.error" role="alert" tw-class="text-sm whitespace-pre-wrap break-words text-red-600 dark:text-red-400">{{ snapshot.record.error }}</p>
          <div tw-class="flex flex-wrap gap-2">
            <button type="button" :disabled="busy || workspace.busy.value" @click="copySnapshot" data-testid="workflow-copy-run" tw-class="inline-flex items-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 px-4 py-2 text-xs font-semibold text-white focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 transition-colors"><CopyIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__copy_snapshot_to_edit() }}</button>
            <button type="button" :disabled="busy || !snapshot.record.resultsPath || resultsMissing" @click="viewResults" data-testid="workflow-history-view" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.workflow__view_result() }}</button>
            <button type="button" :disabled="busy || !snapshot.record.resultsPath || resultsMissing" @click="openResults({ zip: false })" data-testid="workflow-history-files" tw-class="inline-flex gap-2 items-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40"><FolderOpenIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__open_results() }}</button>
            <button type="button" :disabled="busy || !snapshot.record.resultsPath || resultsMissing" @click="openResults({ zip: true })" data-testid="workflow-history-zip" tw-class="inline-flex gap-2 items-center rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40"><DownloadIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__download_zip() }}</button>
            <button v-if="snapshot.record.status === 'running'" type="button" :disabled="busy || isLive || activity !== 'recoverable'" @click="markInterrupted" data-testid="workflow-mark-interrupted" tw-class="inline-flex items-center gap-2 rounded-xl border border-amber-300 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40"><AlertTriangleIcon tw-class="w-4 h-4" />{{ lazyStrings.workflow__mark_interrupted() }}</button>
            <button type="button" :disabled="busy || isLive || snapshot.record.status === 'running'" @click="removeRecord" data-testid="workflow-delete-run" :aria-label="lazyStrings.workflow__delete()" tw-class="rounded-xl p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-40"><Trash2Icon tw-class="w-4 h-4" /></button>
          </div>
          <WorkflowResultGallery :sources="resultSources" />
          <p v-if="resultsMissing || (!snapshot.record.resultsPath && !isLive)" tw-class="text-xs text-gray-500" data-testid="workflow-results-unavailable">{{ lazyStrings.workflow__result_files_unavailable() }}</p>
          <p v-if="snapshot.record.resultError" tw-class="text-xs text-amber-700 dark:text-amber-400 break-words">{{ snapshot.record.resultError }}</p>
        </section>
        <WorkflowDisclosure :title="lazyStrings.workflow__run_snapshot()" :initially-open="true">
          <div tw-class="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400"><AlertTriangleIcon tw-class="w-4 h-4 shrink-0" /><p>{{ lazyStrings.workflow__history_contains_private_data() }}</p></div>
          <ol tw-class="space-y-2">
            <li v-for="step in steps" :key="idToRaw({ id: step.id })" tw-class="flex gap-3 items-center rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2 text-sm"><span tw-class="min-w-0 flex-1 truncate">{{ step.name }}</span><span tw-class="text-xs text-gray-500">{{ workflowStepLabel({ type: step.type }) }}</span></li>
          </ol>
          <WorkflowDisclosure :title="lazyStrings.workflow__json()"><pre tw-class="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs font-mono text-gray-600 dark:text-gray-300">{{ definitionText }}</pre></WorkflowDisclosure>
        </WorkflowDisclosure>
        <p tw-class="text-xs leading-relaxed text-gray-500">{{ lazyStrings.workflow__history_preview_notice() }}</p>
        <article v-for="entry in entries" :key="entry.number" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
          <header tw-class="flex flex-wrap gap-2 text-xs"><span tw-class="text-gray-400">{{ entry.number }}</span><strong tw-class="flex-1">{{ entry.name }}</strong><span tw-class="text-gray-400">{{ entry.trace.join(' / ') }}</span><span tw-class="text-gray-500">{{ entry.phase === 'completed' ? lazyStrings.workflow__completed() : isLive ? lazyStrings.workflow__running() : lazyStrings.workflow__unfinished_run() }}</span></header>
          <WorkflowDisclosure v-if="entry.inputPreview" :title="lazyStrings.workflow__input_preview()"><pre tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{{ entry.inputPreview }}</pre></WorkflowDisclosure>
          <pre v-if="entry.preview" tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{{ entry.preview }}</pre>
        </article>
      </template>
    </div>
  </main>
</template>
