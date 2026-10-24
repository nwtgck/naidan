import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { preferredAudioModel, type AudioModelDetection, type inspectStoredAudioModel } from '@/features/audio-generation/model-detection';

export function useAudioModels({ inspect }: { inspect: typeof inspectStoredAudioModel }) {
  const models = shallowRef<LocalModel[]>([]);
  const modelId = ref('');
  const scope = ref<'detected' | 'all'>('detected');
  const scanState = ref<'idle' | 'scanning'>('idle');
  const detections = shallowRef<ReadonlyMap<string, AudioModelDetection>>(new Map());
  const selectionOrigin = ref<'automatic' | 'manual'>('automatic');
  let scan: AbortController | undefined;
  let disposed = false;
  const visibleModels = computed(() => models.value.filter(entry => scope.value === 'all'
    || detections.value.get(entry.modelId)?.status === 'detected' || entry.modelId === modelId.value));
  const detectedCount = computed(() => models.value.filter(entry => detections.value.get(entry.modelId)?.status === 'detected').length);

  function isDetected({ modelId }: { modelId: string }): boolean {
    const status = detections.value.get(modelId)?.status;
    switch (status) {
    case 'detected': return true;
    case 'unverified': case undefined: return false;
    default: {
      const exhaustive: never = status;
      throw new Error(String(exhaustive));
    }
    }
  }
  function chooseDefault(): void {
    if (selectionOrigin.value === 'manual' && models.value.some(entry => entry.modelId === modelId.value)) {
      // A user selection wins over a late scan, even when metadata is unknown.
      if (!isDetected({ modelId: modelId.value })) {
        scope.value = 'all';
      }
      return;
    }
    // A refresh must not replace a still-detected automatic selection merely
    // because a smaller model was downloaded in the meantime.
    if (isDetected({ modelId: modelId.value })) {
      return;
    }
    modelId.value = preferredAudioModel({ models: models.value, detections: detections.value }) ?? '';
  }
  async function scanModels({ entries, controller }: { entries: LocalModel[], controller: AbortController }): Promise<void> {
    const next = new Map<string, AudioModelDetection>();
    try {
      // Deliberately sequential: no burst of open model files or metadata buffers.
      for (const entry of entries) {
        controller.signal.throwIfAborted();
        let detection: AudioModelDetection;
        try {
          detection = await inspect({ modelId: entry.modelId, signal: controller.signal });
        } catch {
          controller.signal.throwIfAborted();
          detection = { status: 'unverified', reason: 'metadata' };
        }
        if (disposed || scan !== controller || controller.signal.aborted) {
          return;
        }
        next.set(entry.modelId, detection);
        detections.value = new Map(next);
      }
      if (!disposed && scan === controller && !controller.signal.aborted) {
        chooseDefault();
      }
    } catch {
      // Cancellation is expected on a new inventory, route exit, or teardown.
    } finally {
      if (scan === controller) {
        scan = undefined;
        scanState.value = 'idle';
      }
    }
  }
  function updateModels({ entries }: { entries: LocalModel[] }): void {
    if (disposed) {
      return;
    }
    scan?.abort();
    models.value = [...entries];
    if (!entries.some(entry => entry.modelId === modelId.value)) {
      modelId.value = '';
      selectionOrigin.value = 'automatic';
    }
    detections.value = new Map();
    const controller = new AbortController();
    scan = controller;
    scanState.value = 'scanning';
    void scanModels({ entries: models.value, controller });
  }
  function selectionChanged(): void {
    selectionOrigin.value = 'manual';
  }
  function selectModel({ modelId: selectedModelId }: { modelId: string }): void {
    const matches = models.value.filter(entry => entry.modelId === selectedModelId);
    if (matches.length !== 1) {
      return;
    }
    modelId.value = matches[0]!.modelId;
    selectionChanged();
    if (!isDetected({ modelId: modelId.value })) {
      scope.value = 'all';
    }
  }
  function scopeChanged(): void {
    if (scope.value === 'detected' && !isDetected({ modelId: modelId.value })) {
      modelId.value = '';
      selectionOrigin.value = 'automatic';
      chooseDefault();
    }
  }
  function showAllModels(): void {
    scope.value = 'all';
  }
  onScopeDispose(() => {
    disposed = true;
    scan?.abort();
    scan = undefined;
  });
  return {
    models,
    modelId,
    scope,
    scanState,
    detections,
    visibleModels,
    detectedCount,
    updateModels,
    selectModel,
    selectionChanged,
    scopeChanged,
    showAllModels,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
