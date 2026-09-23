import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { preferredAudioModel, type AudioModelDetection, type inspectStoredAudioModel } from '@/features/audio-generation/model-detection';

export function useAudioModels({ inspect }: { inspect: typeof inspectStoredAudioModel }) {
  const models = shallowRef<LocalModel[]>([]);
  const model = ref('');
  const scope = ref<'detected' | 'all'>('detected');
  const scanState = ref<'idle' | 'scanning'>('idle');
  const detections = shallowRef<ReadonlyMap<string, AudioModelDetection>>(new Map());
  const selectionOrigin = ref<'automatic' | 'manual'>('automatic');
  let scan: AbortController | undefined;
  let disposed = false;
  const visibleModels = computed(() => models.value.filter(entry => scope.value === 'all'
    || detections.value.get(entry.id)?.status === 'detected' || entry.id === model.value));
  const detectedCount = computed(() => models.value.filter(entry => detections.value.get(entry.id)?.status === 'detected').length);

  function isDetected({ id }: { id: string }): boolean {
    const status = detections.value.get(id)?.status;
    switch (status) {
    case 'detected': return true;
    case 'unverified': case undefined: return false;
    default: { const exhaustive: never = status; throw new Error(String(exhaustive)); }
    }
  }
  function chooseDefault(): void {
    if (selectionOrigin.value === 'manual' && models.value.some(entry => entry.id === model.value)) {
      // A user selection wins over a late scan, even when metadata is unknown.
      if (!isDetected({ id: model.value })) scope.value = 'all';
      return;
    }
    // A refresh must not replace a still-detected automatic selection merely
    // because a smaller model was downloaded in the meantime.
    if (isDetected({ id: model.value })) return;
    model.value = preferredAudioModel({ models: models.value, detections: detections.value }) ?? '';
  }
  async function scanModels({ entries, controller }: { entries: LocalModel[], controller: AbortController }): Promise<void> {
    const next = new Map<string, AudioModelDetection>();
    try {
      // Deliberately sequential: no burst of open model files or metadata buffers.
      for (const entry of entries) {
        controller.signal.throwIfAborted();
        let detection: AudioModelDetection;
        try {
          detection = await inspect({ id: entry.id, signal: controller.signal });
        } catch {
          controller.signal.throwIfAborted();
          detection = { status: 'unverified', reason: 'metadata' };
        }
        if (disposed || scan !== controller || controller.signal.aborted) return;
        next.set(entry.id, detection);
        detections.value = new Map(next);
      }
      if (!disposed && scan === controller && !controller.signal.aborted) chooseDefault();
    } catch {
      // Cancellation is expected on a new inventory, route exit, or teardown.
    } finally {
      if (scan === controller) {
        scan = undefined; scanState.value = 'idle';
      }
    }
  }
  function updateModels({ entries }: { entries: LocalModel[] }): void {
    if (disposed) return;
    scan?.abort();
    models.value = [...entries];
    if (!entries.some(entry => entry.id === model.value)) {
      model.value = ''; selectionOrigin.value = 'automatic';
    }
    detections.value = new Map();
    const controller = new AbortController(); scan = controller;
    scanState.value = 'scanning';
    void scanModels({ entries: models.value, controller });
  }
  function selectionChanged(): void {
    selectionOrigin.value = 'manual';
  }
  function selectModel({ name }: { name: string }): void {
    const matches = models.value.filter(entry => entry.name === name);
    if (matches.length !== 1) return;
    model.value = matches[0]!.id; selectionChanged();
    if (!isDetected({ id: model.value })) scope.value = 'all';
  }
  function scopeChanged(): void {
    if (scope.value === 'detected' && !isDetected({ id: model.value })) {
      model.value = ''; selectionOrigin.value = 'automatic'; chooseDefault();
    }
  }
  function showAllModels(): void {
    scope.value = 'all';
  }
  onScopeDispose(() => {
    disposed = true; scan?.abort(); scan = undefined;
  });
  return { models, model, scope, scanState, detections, visibleModels, detectedCount, updateModels, selectModel,
    selectionChanged, scopeChanged, showAllModels, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}
export const TEST_ONLY = {
};
