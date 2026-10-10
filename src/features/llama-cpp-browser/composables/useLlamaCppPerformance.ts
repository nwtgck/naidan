import { resolvePerformanceModelInput } from '@/features/llama-cpp-browser/performance/model-input';
import rawRuntimeManifest from 'llama-cpp-browser-core/manifest.json';
import { runtimeBuildEvidence } from '@/features/llama-cpp-browser/performance/runtime-evidence';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { nanoid } from 'nanoid';
import { llamaCppBrowserService as service } from '@/features/llama-cpp-browser';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { type LocalModel, type RuntimeOptions, usesWebGpu } from '@/features/llama-cpp-browser/types';
import { resolveProfilePreference } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { createPerformancePlan } from '@/features/llama-cpp-browser/performance/plan';
import { createPerformanceRunner } from '@/features/llama-cpp-browser/performance/runner';
import { protocolSchema, type PerformanceSnapshot, type PerformanceTrial } from '@/features/llama-cpp-browser/performance/types';

export function useLlamaCppPerformance() {
  const models = shallowRef<LocalModel[]>([]), selected = ref<string[]>([]), query = ref('');
  const repeats = ref(1), maxTokens = ref(64), timeoutMinutes = ref(15), notes = ref('');
  const modelDraft = ref('');
  const diagnostics = ref(true);
  const profile = ref<RuntimeOptions['profile']>(service.getOptions().profile);
  const running = ref(false), stopping = ref(false), exporting = ref(false), loading = ref(false), error = ref('');
  const downloadStarted = ref(false), pageHidden = ref(document.hidden);
  const snapshot = shallowRef<PerformanceSnapshot>(), current = shallowRef<PerformanceTrial>();
  const preview = ref('');
  const serviceState = shallowRef(service.getState());
  const unsubscribe = service.subscribe({
    listener: ({ state }) => {
      serviceState.value = state;
    },
  });
  const queue = getDownloadQueue();
  let disposed = false, seeded = false;
  let currentLive: PerformanceTrial | undefined;
  let startController: AbortController | undefined;
  const filteredModels = computed(() => models.value.filter(model => `${model.name} ${model.id}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
  const draftResolution = computed(() => resolvePerformanceModelInput({ text: modelDraft.value, models: models.value, selected: selected.value }));
  const modelInputError = computed(() => draftResolution.value.errors.join('\n'));
  const selectedModels = computed(() => draftResolution.value.selected.flatMap(id => {
    const model = models.value.find(model => model.id === id); return model ? [model] : [];
  }));
  const otherWork = computed(() => !running.value && (serviceState.value.status === 'working' || queue.jobs.value.some(job => jobIsBusy({ job }))));
  const valid = computed(() => !draftResolution.value.errors.length && selectedModels.value.length > 0 && selectedModels.value.length <= 16 && selectedModels.value.length === draftResolution.value.selected.length
    && notes.value.length <= 10000 && new Set(selectedModels.value.map(model => model.name)).size === selectedModels.value.length
    && protocolSchema.safeParse({ repeats: repeats.value, maxTokens: maxTokens.value, timeoutMs: timeoutMinutes.value * 60000 }).success);
  const canStart = computed(() => !running.value && !exporting.value && !loading.value && !otherWork.value && valid.value);
  const callCount = computed(() => selectedModels.value.length * (1 + repeats.value * 4 + (diagnostics.value ? 1 : 0)));
  const runner = createPerformanceRunner({
    service,
    now: () => performance.now(),
    date: () => new Date().toISOString(),
    hidden: () => document.hidden,
    waitUntilVisible: async ({ signal }) => {
      signal.throwIfAborted(); if (!document.hidden) return;
      await new Promise<void>((resolve, reject) => {
        const clean = () => {
          document.removeEventListener('visibilitychange', changed); signal.removeEventListener('abort', aborted);
        };
        const changed = () => {
          if (!document.hidden) {
            clean(); resolve();
          }
        };
        const aborted = () => {
          clean(); reject(new DOMException('Aborted', 'AbortError'));
        };
        document.addEventListener('visibilitychange', changed); signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted(); else changed();
      });
    },
    publish: ({ snapshot: value, current: trial }) => {
      if (disposed) return;
      snapshot.value = { ...value, trials: [...value.trials] };
      currentLive = trial; current.value = trial ? { ...trial } : undefined;
    },
  });
  const visibilityChanged = () => {
    pageHidden.value = document.hidden; runner.visibilityChanged();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  const previewTimer = setInterval(() => {
    if (!running.value || document.hidden) return;
    current.value = currentLive ? { ...currentLive } : undefined;
    preview.value = currentLive ? `${currentLive.partialReasoning}\n${currentLive.partialText}`.slice(-3000) : '';
  }, 250);
  async function refresh({ defaultModel }: { defaultModel: string | undefined }): Promise<void> {
    if (running.value || loading.value || disposed) return;
    loading.value = true; error.value = '';
    try {
      const found = await service.listModels({ signal: undefined });
      if (disposed) return;
      models.value = found;
      selected.value = selected.value.filter(id => found.some(model => model.id === id));
      if (!seeded) {
        const candidate = found.find(model => model.name === defaultModel || model.id === defaultModel);
        if (candidate) selected.value = [candidate.id];
        seeded = true;
      }
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!disposed) loading.value = false;
    }
  }
  async function download(): Promise<void> {
    const value = snapshot.value;
    if (!value || running.value || exporting.value || disposed) return;
    exporting.value = true; error.value = ''; downloadStarted.value = false;
    try {
      const { performanceArchive } = await import('@/features/llama-cpp-browser/performance/archive');
      const blob = await performanceArchive({ snapshot: value });
      if (disposed) return;
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a'); link.href = url; link.download = `naidan-llama-cpp-performance-${value.plan.id}.zip`; link.click();
        downloadStarted.value = true;
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (!disposed) exporting.value = false;
    }
  }
  function commitModels(): boolean {
    if (running.value || exporting.value) return false;
    const result = draftResolution.value;
    if (result.errors.length) return false;
    selected.value = [...result.selected]; modelDraft.value = ''; return true;
  }
  function pasteModels({ event }: { event: ClipboardEvent }): void {
    if (running.value || exporting.value) return;
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (!pasted.length) return;
    // Match the Transformers.js investigation: paste appends whole model lines,
    // not text at the caret. A malformed batch remains an editable draft.
    const combined = modelDraft.value.trim().length ? `${modelDraft.value}\n${pasted}` : pasted;
    event.preventDefault();
    modelDraft.value = combined;
    commitModels();
  }
  function keydownModels({ event }: { event: KeyboardEvent }): void {
    if (running.value || exporting.value || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault(); commitModels();
  }
  async function copyModels(): Promise<void> {
    if (draftResolution.value.errors.length || !selectedModels.value.length) return;
    try {
      // IDs round-trip even when display names are ambiguous. Include a valid
      // uncommitted draft, just like the Transformers.js model list.
      await navigator.clipboard.writeText(selectedModels.value.map(model => model.id).join('\n'));
    } catch { /* Clipboard failure is non-semantic and must not change the list. */ }
  }
  function stop(): void {
    if (!running.value) return;
    stopping.value = true; startController?.abort(); runner.stop();
  }
  async function start(): Promise<void> {
    if (!canStart.value || disposed || !commitModels()) return;
    // Capture the form before any await, including capability detection.
    let plan = createPerformancePlan({
      id: nanoid(),
      createdAt: new Date().toISOString(),
      models: selectedModels.value,
      settings: { repeats: repeats.value, maxTokens: maxTokens.value, timeoutMs: timeoutMinutes.value * 60000, diagnostics: diagnostics.value ? 'placement' : 'none' },
      options: { profile: profile.value },
      notes: notes.value,
    });
    const environment: PerformanceSnapshot['environment'] = {
      appVersion: __APP_VERSION__,
      buildMode: __BUILD_MODE_IS_HOSTED__ ? 'hosted' : 'standalone',
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      timeOrigin: performance.timeOrigin,
      runtimeBuild: runtimeBuildEvidence({ manifest: rawRuntimeManifest }),
    };
    running.value = true; stopping.value = false; downloadStarted.value = false; error.value = ''; preview.value = '';
    snapshot.value = undefined;
    const control = new AbortController(); startController = control;
    let wakeLock: WakeLockSentinel | undefined;
    let acceptWakeLock = true;
    let startedRunner = false;
    try {
      const capabilities = await service.probeProfiles({ signal: control.signal });
      control.signal.throwIfAborted();
      const concrete = resolveProfilePreference({ preference: plan.options.profile, capabilities });
      if (!concrete || (plan.options.profile === 'auto' && !usesWebGpu({ profile: concrete }))) throw new Error('WebGPU is unavailable. Select an explicit CPU profile only for a CPU measurement.');
      plan = { ...plan, options: { profile: concrete } };
      try {
        // Optional browser cooperation must not block starting or stopping a run.
        void navigator.wakeLock?.request('screen').then(lock => {
          if (!acceptWakeLock || control.signal.aborted || disposed) {
            void lock.release().catch(() => {});
          } else wakeLock = lock;
        }).catch(() => {});
      } catch { /* Optional; visibility is recorded independently. */ }
      control.signal.throwIfAborted();
      startedRunner = true;
      await runner.start({ plan, environment });
    } catch (cause) {
      if (!disposed) {
        error.value = cause instanceof Error ? cause.message : String(cause);
        if (!startedRunner) snapshot.value = {
          plan,
          environment,
          status: control.signal.aborted ? 'cancelled' : 'completed',
          trials: [],
          modelErrors: plan.models.map((_, modelIndex) => ({ modelIndex, error: error.value })),
        };
      }
    } finally {
      acceptWakeLock = false;
      // Optional browser cooperation must not hold completed results hostage.
      // A pending release has no ownership of the inference lane.
      try {
        void wakeLock?.release().catch(() => {});
      } catch { /* Best effort, including synchronous platform errors. */ }
      startController = undefined;
      if (!disposed) {
        running.value = false; stopping.value = false; current.value = undefined;
      }
    }
    // Export is intentionally a user action, never completion/cleanup work.
  }
  onScopeDispose(() => {
    disposed = true; startController?.abort(); runner.stop(); unsubscribe();
    clearInterval(previewTimer); document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return {
    modelDraft,
    modelInputError,
    diagnostics,
    commitModels,
    pasteModels,
    keydownModels,
    copyModels,
    models,
    selected,
    query,
    repeats,
    maxTokens,
    timeoutMinutes,
    notes,
    profile,
    running,
    stopping,
    exporting,
    loading,
    error,
    downloadStarted,
    pageHidden,
    snapshot,
    current,
    preview,
    serviceState,
    filteredModels,
    selectedModels,
    otherWork,
    canStart,
    callCount,
    refresh,
    download,
    start,
    stop,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
