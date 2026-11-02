import { isDiagnosticsEditValid, type DiagnosticsQueryConfig } from '@/features/llama-cpp-browser/diagnostics/query-parameters';
import { diagnosticsModelSelection, resolveDiagnosticsModels, type DiagnosticsModelSelection } from '@/features/llama-cpp-browser/diagnostics/model-selection';
import { buildAllowsGpuProfiling, gpuProfilingUnavailableReason } from '@/features/llama-cpp-browser/performance/profiling-mode';
import { resolvePerformanceModelInput } from '@/features/llama-cpp-browser/performance/model-input';
import rawRuntimeManifest from 'llama-cpp-browser-core/manifest.json';
import { runtimeBuildEvidence } from '@/features/llama-cpp-browser/performance/runtime-evidence';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { nanoid } from 'nanoid';
import { llamaCppBrowserService as service } from '@/features/llama-cpp-browser';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { gpuProfilingProfile, type LocalModel, type RuntimeOptions, runtimeOptionsSchema, usesWebGpu } from '@/features/llama-cpp-browser/types';
import { resolveProfilePreference, type ProfileCapabilities } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { createPerformancePlan, createVisionPerformancePlan } from '@/features/llama-cpp-browser/performance/plan';
import { createPerformanceRunner } from '@/features/llama-cpp-browser/performance/runner';
import { runQ8Diagnostic } from '@/features/llama-cpp-browser/performance/run-q8-diagnostic';
import { measurementLanes, protocolSchema, type MeasurementMode, type PerformanceSnapshot, type PerformanceTrial } from '@/features/llama-cpp-browser/performance/types';

export function useLlamaCppDiagnostics() {
  const models = shallowRef<LocalModel[]>([]), query = ref('');
  const defaultModelId = ref<string>();
  const inventoryReady = ref(false);
  const modelSelection = ref<DiagnosticsModelSelection>({ kind: 'default' });
  const selected = computed({
    get: () => resolveDiagnosticsModels({ selection: modelSelection.value, ids: models.value.map(model => model.modelId), defaultModel: defaultModelId.value }),
    set: (ids: string[]) => {
      modelSelection.value = { kind: 'explicit', ids: [...ids] };
    },
  });
  const workload = ref<'text' | 'vision'>('text');
  const repeats = ref(1), maxTokens = ref(64), timeoutMinutes = ref(15), notes = ref('');
  const modelDraft = ref('');
  const diagnostics = ref(true);
  const hosted = buildAllowsGpuProfiling();
  const mode = ref<MeasurementMode>(hosted ? 'gpu-profile' : 'standard');
  const capabilities = shallowRef<ProfileCapabilities>();
  let modeInitialized = false;
  let refreshController: AbortController | undefined;
  const profilingUnavailableReason = computed(() => gpuProfilingUnavailableReason({ hosted, capabilities: capabilities.value }));
  const profilingSupported = computed(() => profilingUnavailableReason.value === undefined);
  const defaultProfile = service.getOptions().profile;
  const profile = ref<RuntimeOptions['profile']>(defaultProfile);
  const contextTokens = ref<number>();
  const visionBf16Storage = ref<RuntimeOptions['visionBf16Storage']>();
  const profileExplicit = ref(false);
  const profileConflict = computed(() => profileExplicit.value && mode.value !== 'standard' && profile.value !== 'auto' && profile.value !== 'webgpu-wasm64-jspi');
  const defaults = computed(() => ({
    workload: 'text' as const,
    mode: profilingSupported.value ? 'gpu-profile' as const : 'standard' as const,
    repeats: 1,
    maxTokens: 64,
    timeoutMinutes: 15,
    placement: true,
    modelFilter: '',
    profile: defaultProfile,
    contextTokens: undefined,
    visionBf16Storage: undefined,
    notes: '',
  }));
  function applyConfiguration({ config }: { config: DiagnosticsQueryConfig }): void {
    const { modelIds: _modelIds, allModels: _allModels, modelFilter, workload: kind, mode: measurementMode, repeats: count, maxTokens: limit,
      timeoutMinutes: timeout, placement, profile: preference, contextTokens: context, visionBf16Storage: storage, notes: memo, ...unhandled } = config;
    unhandled satisfies Record<PropertyKey, never>;
    modelSelection.value = diagnosticsModelSelection({ config });
    query.value = modelFilter ?? defaults.value.modelFilter;
    workload.value = kind ?? defaults.value.workload;
    mode.value = measurementMode ?? defaults.value.mode;
    modeInitialized = measurementMode !== undefined;
    repeats.value = count ?? defaults.value.repeats;
    maxTokens.value = limit ?? defaults.value.maxTokens;
    timeoutMinutes.value = timeout ?? defaults.value.timeoutMinutes;
    diagnostics.value = placement ?? defaults.value.placement;
    profile.value = preference ?? defaults.value.profile;
    profileExplicit.value = preference !== undefined;
    contextTokens.value = context;
    visionBf16Storage.value = storage;
    notes.value = memo ?? defaults.value.notes;
  }
  function configurationEdited({ config }: { config: DiagnosticsQueryConfig }): void {
    // Only explicit actions, not probes or inventory updates, establish intent.
    modeInitialized = config.mode !== undefined;
    profileExplicit.value = config.profile !== undefined;
  }
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
  let disposed = false;
  let currentLive: PerformanceTrial | undefined;
  let startController: AbortController | undefined;
  let exportController: AbortController | undefined;
  const filteredModels = computed(() => models.value.filter(model => model.modelId.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
  const draftResolution = computed(() => resolvePerformanceModelInput({ text: modelDraft.value, models: models.value, selected: selected.value }));
  const modelInputError = computed(() => draftResolution.value.errors.join('\n'));
  const modelsById = computed(() => new Map(models.value.map(model => [model.modelId, model])));
  const selectedModels = computed(() => draftResolution.value.selected.flatMap(id => {
    const model = modelsById.value.get(id);
    return model ? [model] : [];
  }));
  const otherWork = computed(() => !running.value && (serviceState.value.status === 'working' || queue.jobs.value.some(job => jobIsBusy({ job }))));
  const valid = computed(() => !draftResolution.value.errors.length && selectedModels.value.length > 0 && selectedModels.value.length === draftResolution.value.selected.length
    && notes.value.length <= 10000 && new Set(selectedModels.value.map(model => model.modelId)).size === selectedModels.value.length
    && !profileConflict.value && runtimeOptionsSchema.safeParse({ profile: profile.value, contextTokens: contextTokens.value, visionBf16Storage: visionBf16Storage.value }).success
    // The runner accepts millisecond precision; the page/URL accepts whole
    // minutes. Do not run a fractional draft that the URL codec rejected.
    && isDiagnosticsEditValid({ patch: { timeoutMinutes: timeoutMinutes.value } })
    && protocolSchema.safeParse({ mode: mode.value, repeats: repeats.value, maxTokens: maxTokens.value, timeoutMs: timeoutMinutes.value * 60000 }).success);
  const canStart = computed(() => inventoryReady.value && !running.value && !exporting.value && !loading.value && !otherWork.value && valid.value && (mode.value === 'standard' || profilingSupported.value));
  const callCount = computed(() => {
    const perModel = (() => {
      switch (workload.value) {
      case 'vision': return 1 + repeats.value;
      case 'text': return 1 + repeats.value * 4 + (diagnostics.value ? 1 : 0);
      default: {
        const exhaustive: never = workload.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    return selectedModels.value.length * perModel * measurementLanes({ mode: mode.value }).length;
  });
  const runner = createPerformanceRunner({
    service,
    runKernelDiagnostic: runQ8Diagnostic,
    now: () => performance.now(),
    date: () => new Date().toISOString(),
    hidden: () => document.hidden,
    waitUntilVisible: async ({ signal }) => {
      signal.throwIfAborted();
      if (!document.hidden) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const clean = () => {
          document.removeEventListener('visibilitychange', changed);
          signal.removeEventListener('abort', aborted);
        };
        const changed = () => {
          if (!document.hidden) {
            clean();
            resolve();
          }
        };
        const aborted = () => {
          clean();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        document.addEventListener('visibilitychange', changed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) {
          aborted();
        } else {
          changed();
        }
      });
    },
    publish: ({ snapshot: value, current: trial }) => {
      if (disposed) {
        return;
      }
      // Trials are append-only; a fresh shell notifies the UI without copying
      // all previous attempts on each publication. Export is disabled while running.
      snapshot.value = { ...value };
      currentLive = trial;
      current.value = trial ? { ...trial } : undefined;
    },
  });
  const canInterruptCurrent = computed(() => !!current.value && running.value && !stopping.value
    && runner.canInterruptCurrent({ trialId: current.value.id }));
  const interruptionPending = computed(() => running.value && snapshot.value?.trials.some(trial => trial.interruption?.recovery === 'pending') === true);
  function interruptCurrent({ trialId }: { trialId: string }): boolean {
    return !disposed && running.value && !stopping.value && runner.interruptCurrent({ trialId });
  }
  const visibilityChanged = () => {
    pageHidden.value = document.hidden;
    runner.visibilityChanged();
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  const previewTimer = setInterval(() => {
    if (!running.value || document.hidden) {
      return;
    }
    current.value = currentLive ? { ...currentLive } : undefined;
    preview.value = currentLive ? `${currentLive.partialReasoning}\n${currentLive.partialText}`.slice(-3000) : '';
  }, 250);
  async function refresh({ defaultModel }: { defaultModel: string | undefined }): Promise<void> {
    if (running.value || loading.value || disposed) {
      return;
    }
    loading.value = true;
    inventoryReady.value = false;
    error.value = '';
    const control = new AbortController();
    refreshController = control;
    try {
      const found = await service.listModelEntries({ signal: control.signal });
      if (disposed) {
        return;
      }
      models.value = found;
      inventoryReady.value = true;
      defaultModelId.value = defaultModel;
      try {
        const detected = await service.probeProfiles({ signal: control.signal });
        if (!disposed && !control.signal.aborted) {
          capabilities.value = detected;
        }
      } catch {
        if (!disposed) {
          capabilities.value = undefined;
        }
      }
      // Only initialize the default. Never silently change a user's selected
      // mode when a later probe fails; keep it disabled with its explanation.
      if (!modeInitialized && !disposed) {
        mode.value = profilingSupported.value ? 'gpu-profile' : 'standard';
        modeInitialized = true;
      }
    } catch (cause) {
      if (!disposed) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (!disposed) {
        loading.value = false;
      }
      refreshController = undefined;
    }
  }
  async function download(): Promise<void> {
    const value = snapshot.value;
    if (!value || running.value || exporting.value || disposed) {
      return;
    }
    exporting.value = true;
    error.value = '';
    downloadStarted.value = false;
    try {
      const control = new AbortController();
      exportController = control;
      const { createPerformanceArchiveStream } = await import('@/features/llama-cpp-browser/performance/archive');
      const { downloadReadableStream } = await import('@/utils/stream-download');
      control.signal.throwIfAborted();
      await downloadReadableStream({
        stream: createPerformanceArchiveStream({ snapshot: value, signal: control.signal }),
        filename: `naidan-llama-cpp-performance-${value.plan.id}.zip`,
        size: undefined,
        signal: control.signal,
      });
      if (!disposed) {
        downloadStarted.value = true;
      }
    } catch (cause) {
      if (!disposed) {
        error.value = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      if (!disposed) {
        exporting.value = false;
      }
      exportController = undefined;
    }
  }
  function commitModels(): boolean {
    if (running.value || exporting.value) {
      return false;
    }
    if (!modelDraft.value.trim()) {
      return !draftResolution.value.errors.length;
    }
    const result = draftResolution.value;
    if (result.errors.length) {
      return false;
    }
    selected.value = [...result.selected];
    modelDraft.value = '';
    return true;
  }
  function pasteModels({ event }: { event: ClipboardEvent }): void {
    if (running.value || exporting.value) {
      return;
    }
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (!pasted.length) {
      return;
    }
    // Match the Transformers.js investigation: paste appends whole model lines,
    // not text at the caret. A malformed batch remains an editable draft.
    const combined = modelDraft.value.trim().length ? `${modelDraft.value}\n${pasted}` : pasted;
    event.preventDefault();
    modelDraft.value = combined;
    commitModels();
  }
  function keydownModels({ event }: { event: KeyboardEvent }): void {
    if (running.value || exporting.value || event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    commitModels();
  }
  async function copyModels(): Promise<void> {
    if (draftResolution.value.errors.length || !selectedModels.value.length) {
      return;
    }
    try {
      // Copy the same modelId values that are displayed and accepted on paste.
      // Include a valid uncommitted draft.
      await navigator.clipboard.writeText(selectedModels.value.map(model => model.modelId).join('\n'));
    } catch { /* Clipboard failure is non-semantic and must not change the list. */ }
  }
  function stop(): void {
    if (!running.value) {
      return;
    }
    stopping.value = true;
    startController?.abort();
    runner.stop();
  }
  async function start(): Promise<void> {
    if (!canStart.value || disposed || !commitModels()) {
      return;
    }
    // Capture the form before any await, including capability detection.
    const createPlan = (() => {
      switch (workload.value) {
      case 'vision': return createVisionPerformancePlan;
      case 'text': return createPerformancePlan;
      default: {
        const exhaustive: never = workload.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    let plan = createPlan({
      id: nanoid(),
      createdAt: new Date().toISOString(),
      models: selectedModels.value,
      settings: { mode: mode.value, repeats: repeats.value, maxTokens: maxTokens.value, timeoutMs: timeoutMinutes.value * 60000, diagnostics: diagnostics.value ? 'placement' : 'none' },
      options: { profile: profile.value, ...(contextTokens.value !== undefined ? { contextTokens: contextTokens.value } : {}), ...(visionBf16Storage.value !== undefined ? { visionBf16Storage: visionBf16Storage.value } : {}) },
      notes: notes.value,
    });
    const environment: PerformanceSnapshot['environment'] = {
      appVersion: __APP_VERSION__,
      appSource: { ...__APP_SOURCE__ },
      buildMode: hosted ? 'hosted' : 'standalone',
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      timeOrigin: performance.timeOrigin,
      runtimeBuild: runtimeBuildEvidence({ manifest: rawRuntimeManifest }),
    };
    running.value = true;
    stopping.value = false;
    downloadStarted.value = false;
    error.value = '';
    preview.value = '';
    snapshot.value = undefined;
    const control = new AbortController();
    startController = control;
    let wakeLock: WakeLockSentinel | undefined;
    let acceptWakeLock = true;
    let startedRunner = false;
    try {
      const capabilities = await service.probeProfiles({ signal: control.signal });
      control.signal.throwIfAborted();
      if (plan.settings.mode === 'gpu-profile' || plan.settings.mode === 'both') {
        for (const required of [gpuProfilingProfile, 'webgpu-wasm64-jspi'] as const) {
          const entry = capabilities.profiles.find(entry => entry.profile === required);
          switch (entry?.status) {
          case 'available': break;
          case 'unavailable': throw new Error(`GPU profiling is unavailable: ${entry.reason}`);
          case undefined: throw new Error('GPU profiling is unavailable: profiling-artifact');
          default: {
            const exhaustive: never = entry;
            throw new Error(String(exhaustive));
          }
          }
        }
      }
      const concrete = resolveProfilePreference({ preference: plan.options.profile, capabilities });
      if (!concrete || (plan.options.profile === 'auto' && !usesWebGpu({ profile: concrete }))) {
        throw new Error('WebGPU is unavailable. Select an explicit CPU profile only for a CPU measurement.');
      }
      plan = { ...plan, options: { ...plan.options, profile: concrete } };
      try {
        // Optional browser cooperation must not block starting or stopping a run.
        void navigator.wakeLock?.request('screen').then(lock => {
          if (!acceptWakeLock || control.signal.aborted || disposed) {
            void lock.release().catch(() => {});
          } else {
            wakeLock = lock;
          }
        }).catch(() => {});
      } catch { /* Optional; visibility is recorded independently. */ }
      control.signal.throwIfAborted();
      startedRunner = true;
      await runner.start({ plan, environment });
    } catch (cause) {
      if (!disposed) {
        error.value = cause instanceof Error ? cause.message : String(cause);
        if (!startedRunner) {
          snapshot.value = {
            plan,
            environment,
            status: control.signal.aborted ? 'cancelled' : 'completed',
            trials: [],
            modelErrors: plan.models.map((_, modelIndex) => ({ modelIndex, error: error.value })),
          };
        }
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
        running.value = false;
        stopping.value = false;
        current.value = undefined;
      }
    }
    // Export is intentionally a user action, never completion/cleanup work.
  }
  onScopeDispose(() => {
    disposed = true;
    startController?.abort();
    refreshController?.abort();
    exportController?.abort();
    runner.stop();
    unsubscribe();
    clearInterval(previewTimer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return {
    applyConfiguration,
    configurationEdited,
    defaults,
    modelSelection,
    contextTokens,
    visionBf16Storage,
    profileConflict,
    workload,
    canInterruptCurrent,
    interruptionPending,
    interruptCurrent,
    mode,
    profilingUnavailableReason,
    profilingSupported,
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
