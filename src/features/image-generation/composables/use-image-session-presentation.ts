import { nanoid } from 'nanoid';
import { ensureStrings } from '@/strings';
import { downloadBlob } from '@/utils/stream-download';
import { computed, shallowRef, watch, type Ref } from 'vue';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';

type Snapshot = {
  latestRun: ImageGenerationView['latestRun']['value'],
  progress: ImageGenerationView['progress']['value'],
  failure: string, invalid: boolean, cancelled: boolean, previewError: string,
  diagnosticText: string, diagnosticStatus: string, diagnosticFeedback: string,
  startedAt: number | undefined,
};

/** The existing galleries own bytes and URLs. This layer only associates their
 * IDs and small presentation snapshots with a session, never another engine. */
export function useImageSessionPresentation({ generation, selectedKey }: { generation: ImageGenerationView, selectedKey: Readonly<Ref<string>> }) {
  const ownerKey = shallowRef<string>();
  const revision = shallowRef(0);
  const snapshots = new Map<string, Snapshot>();
  const resultOwners = new Map<number, string>(), previewOwners = new Map<number, string>();
  let startedAt: number | undefined;
  let capturing = false;
  function capture(): void {
    const key = ownerKey.value;
    if (!key) return;
    if (capturing) {
      snapshots.set(key, {
        latestRun: generation.latestRun.value && { ...generation.latestRun.value },
        progress: generation.progress.value && { ...generation.progress.value },
        failure: generation.failure.value,
        invalid: generation.invalid.value,
        cancelled: generation.cancelled.value,
        previewError: generation.previewError.value,
        diagnosticText: generation.diagnosticText.value,
        diagnosticStatus: generation.diagnosticStatus.value,
        diagnosticFeedback: generation.diagnosticFeedback.value,
        startedAt,
      });
      for (const result of generation.results.value) if (!resultOwners.has(result.id)) resultOwners.set(result.id, key);
      for (const preview of generation.previewSnapshots.value) if (!previewOwners.has(preview.id)) previewOwners.set(preview.id, key);
      if (generation.livePreview.value && !previewOwners.has(generation.livePreview.value.id)) previewOwners.set(generation.livePreview.value.id, key);
    }
    const results = new Set(generation.results.value.map(result => result.id));
    const previews = new Set([...generation.previewSnapshots.value.map(preview => preview.id), generation.livePreview.value?.id]);
    for (const id of resultOwners.keys()) if (!results.has(id)) resultOwners.delete(id);
    for (const id of previewOwners.keys()) if (!previews.has(id)) previewOwners.delete(id);
    // Output bytes remain protected by the existing bounded galleries and save sinks.
    for (const old of snapshots.keys()) {
      if (snapshots.size <= 64) break;
      if (old !== key && old !== selectedKey.value) snapshots.delete(old);
    }
    revision.value++;
  }
  function begin({ key }: { key: string }): void {
    capture();
    capturing = false; ownerKey.value = undefined;
    generation.latestRun.value = undefined; generation.progress.value = undefined;
    generation.failure.value = ''; generation.invalid.value = false; generation.cancelled.value = false;
    generation.previewError.value = ''; generation.diagnosticText.value = ''; generation.diagnosticStatus.value = ''; generation.diagnosticFeedback.value = '';
    startedAt = performance.now(); ownerKey.value = key; capturing = true;
    capture();
  }
  function finish(): void {
    capture(); capturing = false;
  }
  watch(() => [generation.latestRun.value, generation.progress.value, generation.failure.value, generation.invalid.value,
    generation.cancelled.value, generation.previewError.value, generation.diagnosticText.value, generation.diagnosticStatus.value,
    generation.diagnosticFeedback.value, generation.results.value, generation.previewSnapshots.value, generation.livePreview.value], capture, { flush: 'sync' });
  watch(generation.busy, value => {
    if (!value && capturing) finish();
  }, { flush: 'sync' });
  const snapshot = computed(() => {
    void revision.value; return snapshots.get(selectedKey.value);
  });
  const belongs = computed(() => ownerKey.value === selectedKey.value);
  const view: ImageGenerationView = {
    ...generation,
    latestRun: computed(() => snapshot.value?.latestRun),
    progress: computed(() => snapshot.value?.progress),
    failure: computed(() => snapshot.value?.failure ?? ''),
    invalid: computed(() => snapshot.value?.invalid ?? false),
    cancelled: computed(() => snapshot.value?.cancelled ?? false),
    previewError: computed(() => snapshot.value?.previewError ?? ''),
    diagnosticText: computed(() => snapshot.value?.diagnosticText ?? ''),
    diagnosticStatus: computed(() => snapshot.value?.diagnosticStatus ?? ''),
    diagnosticFeedback: computed(() => snapshot.value?.diagnosticFeedback ?? ''),
    busy: computed(() => belongs.value && generation.busy.value),
    stopping: computed(() => belongs.value && generation.stopping.value),
    results: computed(() => {
      void revision.value; return generation.results.value.filter(result => resultOwners.get(result.id) === selectedKey.value);
    }),
    previewSnapshots: computed(() => {
      void revision.value; return generation.previewSnapshots.value.filter(preview => previewOwners.get(preview.id) === selectedKey.value);
    }),
    livePreview: computed(() => {
      void revision.value; const preview = generation.livePreview.value; return preview && previewOwners.get(preview.id) === selectedKey.value ? preview : undefined;
    }),
    async copyDiagnostics() {
      const key = selectedKey.value, previous = snapshots.get(key);
      if (!previous) return;
      let feedback: string;
      try {
        await navigator.clipboard.writeText(previous.diagnosticText);
        feedback = await ensureStrings.stableDiffusionCppBrowser__logs_copied();
      } catch {
        feedback = await ensureStrings.stableDiffusionCppBrowser__logs_copy_failed();
      }
      if (snapshots.get(key) === previous) {
        snapshots.set(key, { ...previous, diagnosticFeedback: feedback }); revision.value++;
      }
    },
    saveDiagnostics() {
      downloadBlob({ blob: new Blob([view.diagnosticText.value], { type: 'text/plain;charset=utf-8' }), filename: `naidan-image-diagnostics-${nanoid()}.jsonl` });
    },
    clearResults() {
      for (const result of view.results.value) generation.removeResult({ resultId: result.id });
    },
    clearPreviews() {
      for (const preview of view.previewSnapshots.value) generation.removePreview({ previewId: preview.id });
    },
  };
  function clear(): void {
    capturing = false; ownerKey.value = undefined; snapshots.clear(); resultOwners.clear(); previewOwners.clear(); startedAt = undefined; revision.value++;
  }
  return { ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}), view, begin, finish, clear, ownerKey, startedAt: computed(() => snapshot.value?.startedAt), otherRunning: computed(() => generation.busy.value && !belongs.value) };
}

export const TEST_ONLY = {
};
