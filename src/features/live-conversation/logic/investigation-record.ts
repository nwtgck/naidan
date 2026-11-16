import configuration from 'virtual:speech-cpp-browser/config';
import { createSpeechInvestigationRecorder } from '@/features/speech-cpp-browser/investigation/recorder';
import type { SpeechInvestigationEnvironment, SpeechInvestigationMeasurement, SpeechInvestigationOperation, SpeechInvestigationSnapshot, SpeechInvestigationStatus, SpeechObservation } from '@/features/speech-cpp-browser/investigation/types';
import type { SpeechInvestigationAudio, SpeechInvestigationAudioRole, SpeechInvestigationEvent } from '@/features/speech-cpp-browser/investigation/types';
import type { SpeechInvestigationBinding, SpeechInvestigationContext } from '@/features/speech-cpp-browser/worker/investigation-context';
import type { SpeechModelInfo, SpeechFailure, SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import type { SpeechRecognitionCandidateInfo, SpeechRecognitionModelInfo } from '@/features/speech-cpp-browser/recognition/types';
import type { SpeechRecognitionRun } from '@/features/speech-cpp-browser/recognition/controller';
import type { SpeechFileRunState } from './speech-file-run';
import { createModelLoadEstimate, modelLoadEstimateMethod, modelLoadStageWeights } from './model-load-progress';
import type { SpeechInputLevelSettings } from './audio-level';
import type { SpeechInvestigationJsonObject } from '@/features/speech-cpp-browser/investigation/types';

function observed<T>({ value, source }: { value: T, source: string }): SpeechObservation<T> {
  return { status: 'observed', value, source };
}

function unknown({ reason }: { reason: string }): { status: 'unknown', reason: string } {
  return { status: 'unknown', reason };
}

function unset({ reason }: { reason: string }): { status: 'unset', reason: string } {
  return { status: 'unset', reason };
}

function inputLevelRequest({ requested }: { requested: SpeechInputLevelSettings }): SpeechInvestigationJsonObject {
  switch (requested.kind) {
  case 'gain': {
    const { kind, gain, ...unhandled } = requested;
    unhandled satisfies Record<PropertyKey, never>;
    return { kind, gain: Number.isFinite(gain) ? gain : String(gain) };
  }
  case 'peak': {
    const { kind, targetPeak, ...unhandled } = requested;
    unhandled satisfies Record<PropertyKey, never>;
    return { kind, targetPeak: Number.isFinite(targetPeak) ? targetPeak : String(targetPeak) };
  }
  default: {
    const exhaustive: never = requested;
    throw new Error(String(exhaustive));
  }
  }
}

function measured({ value, unit, boundary }: { value: number | undefined, unit: SpeechInvestigationMeasurement['unit'], boundary: string }): SpeechInvestigationMeasurement {
  return { value: value === undefined ? unknown({ reason: 'This interval was not measured' }) : observed({ value, source: boundary }), unit, boundary };
}

export function captureInvestigationEnvironment(): SpeechInvestigationEnvironment {
  return {
    app: {
      version: __APP_VERSION__,
      sourceCommit: __APP_SOURCE__.sourceCommit === undefined ? unknown({ reason: 'Build source revision was unavailable' }) : observed({ value: __APP_SOURCE__.sourceCommit, source: 'Build-time source identity' }),
      workingTree: (() => {
        switch (__APP_SOURCE__.workingTree) {
        case 'clean': case 'dirty': return observed({ value: __APP_SOURCE__.workingTree, source: 'Build-time source identity' });
        case 'unknown': return unknown({ reason: 'Build working tree state was unavailable' });
        default: {
          const exhaustive: never = __APP_SOURCE__.workingTree;
          throw new Error(String(exhaustive));
        }
        }
      })(),
      mode: __BUILD_MODE_IS_STANDALONE__ ? 'standalone' : 'hosted',
    },
    runtime: (() => {
      switch (configuration.kind) {
      case 'available': return observed({ value: { sourceCommit: configuration.sourceCommit, profile: configuration.artifact.profile, variant: 'browser' as const, wasmSha256: configuration.artifact.wasmSha256, wasmBytes: configuration.artifact.wasmBytes, schemaSha256: configuration.artifact.schemaSha256, wasmVerification: 'manifest_only' as const, assetOrigin: observed({ value: configuration.artifact.wasmPath, source: 'Build-provided hosting path, relative to this application' }) }, source: 'Build-provided speech artifact identity; byte verification requires a matching runtime event' });
      case 'unavailable': return { status: 'unavailable' as const, reason: configuration.reason };
      default: {
        const exhaustive: never = configuration;
        throw new Error(String(exhaustive));
      }
      }
    })(),
    browser: {
      userAgent: observed({ value: navigator.userAgent, source: 'navigator.userAgent' }),
      hardwareConcurrency: observed({ value: navigator.hardwareConcurrency, source: 'navigator.hardwareConcurrency' }),
      crossOriginIsolated: typeof globalThis.crossOriginIsolated === 'boolean' ? observed({ value: globalThis.crossOriginIsolated, source: 'globalThis.crossOriginIsolated' }) : unknown({ reason: 'crossOriginIsolated is unavailable' }),
      visibility: observed({ value: document.visibilityState, source: 'document.visibilityState' }),
      timeOrigin: observed({ value: performance.timeOrigin, source: 'performance.timeOrigin' }),
    },
    gpuDevice: unknown({ reason: 'The adapter actually used by the runtime was not observed; no new adapter was probed' }),
  };
}

function initialOperation({ task, modelId, model, modelFile, file, recording, language, seed, maxSeconds, inputPacing, instructions }: {
  task: SpeechInvestigationOperation['task'], modelId: string, model: SpeechModelInfo | SpeechRecognitionCandidateInfo | undefined, modelFile: File | undefined,
  file: File | undefined, recording: boolean, language: string | undefined, seed: number | undefined, maxSeconds: number | undefined,
  inputPacing: SpeechFileRunState['inputPacing'] | undefined, instructions: string | undefined,
}): SpeechInvestigationOperation {
  const modelName = model?.name ?? modelFile?.name;
  const modelBytes = model?.bytes ?? modelFile?.size;
  if (modelName === undefined || modelBytes === undefined) {
    throw new Error('A model snapshot is required for an investigation');
  }
  const requested = {
    language: language === undefined ? unset({ reason: 'No explicit language was supplied at this boundary' }) : observed({ value: language, source: 'UI operation acceptance' }),
    seed: seed === undefined ? unset({ reason: 'No seed was supplied' }) : observed({ value: seed, source: 'UI operation acceptance' }),
    maxSeconds: maxSeconds === undefined ? unset({ reason: 'No duration option was supplied' }) : observed({ value: maxSeconds, source: 'UI operation acceptance' }),
    inputPacing: inputPacing === undefined ? (() => {
      switch (task) {
      case 'recognition': return { status: 'not_applicable' as const, reason: 'Recognition consumes an audio buffer' };
      case 'dialogue': return unset({ reason: 'Input pacing was not supplied at this boundary' });
      default: {
        const exhaustive: never = task;
        throw new Error(String(exhaustive));
      }
      }
    })() : observed({ value: inputPacing, source: 'File replay operation snapshot' }),
    device: unknown({ reason: 'Native device selection was not observed' }),
    threads: unknown({ reason: 'Native thread selection was not observed' }),
    warmup: unknown({ reason: 'Native warmup selection was not observed' }),
  };
  return {
    task,
    model: { id: observed({ value: modelId, source: 'Selected model snapshot' }), name: modelName, bytes: modelBytes, source: 'local model inventory', info: model === undefined ? unknown({ reason: 'Selected model metadata has not completed loading' }) : observed({ value: { architecture: model.architecture, task: model.task, sampleRate: model.sampleRate, requiredVersion: model.requiredVersion }, source: 'Public loaded model description; native JSON is separately recorded in model_info events when observed' }) },
    source: file === undefined ? { kind: 'unset', reason: 'No input audio File was available at this capture boundary' } : { kind: recording ? 'recording' : 'file', name: file.name, bytes: file.size, mediaType: file.type, captureRequested: recording ? unknown({ reason: 'Capture constraints were not forwarded to this record' }) : { status: 'not_applicable', reason: 'File input' }, captureActual: recording ? unknown({ reason: 'Actual MediaTrackSettings were not forwarded to this record' }) : { status: 'not_applicable', reason: 'File input' } },
    requested,
    effective: { language: unknown({ reason: 'Native effective language was not observed' }), seed: unknown({ reason: 'Native effective seed was not observed' }), maxSeconds: unknown({ reason: 'Native effective duration limit was not observed' }), inputPacing: requested.inputPacing, device: requested.device, threads: requested.threads, warmup: requested.warmup },
    processing: unknown({ reason: 'Processing has not completed' }),
    result: {
      text: '',
      languages: [],
      completion: unknown({ reason: 'Processing has not completed' }),
      input: unknown({ reason: 'Input PCM statistics were not observed' }),
      output: (() => {
        switch (task) {
        case 'recognition': return { status: 'not_applicable' as const, reason: 'Recognition produces text' };
        case 'dialogue': return unknown({ reason: 'Output PCM statistics were not observed' });
        default: {
          const exhaustive: never = task;
          throw new Error(String(exhaustive));
        }
        }
      })(),
      details: unknown({ reason: 'No native result has been observed yet' }),
    },
    measurements: { modelLoad: measured({ value: undefined, unit: 'milliseconds', boundary: 'The resident model was already loaded before this operation record began' }) },
    failure: unset({ reason: 'No failure has been reported' }),
    privateInputs: { persona: instructions, instructions: undefined, name: undefined },
  };
}

/** One UI-owned record. Source/model/settings are captured when a controller
 * accepts a run, never reconstructed from the current selection at download. */
export function createInvestigationRecord({ changed }: { changed: ({ id }: { id: string | undefined }) => void }) {
  const recorder = createSpeechInvestigationRecorder({ now: () => performance.now(), nowIso: () => new Date().toISOString() });
  let current: { operationId: string | undefined, modelId: string, modelFile: File | undefined, phase: 'loading' | 'awaiting_run' | 'running' | 'finished', loadStarted: number | undefined, inputStarted: number | undefined, estimate: ReturnType<typeof createModelLoadEstimate>, lastEstimate: number | undefined, lastLoadStage: string | undefined, task: SpeechInvestigationOperation['task'], handle: ReturnType<typeof recorder.begin>, environment: SpeechInvestigationEnvironment, operation: SpeechInvestigationOperation, state: 'open' | 'finished' } | undefined;
  function begin({ operationId, modelId, modelFile, operation, file, phase }: { operationId: string | undefined, modelId: string, modelFile: File | undefined, operation: SpeechInvestigationOperation, file: File | undefined, phase: 'loading' | 'awaiting_run' | 'running' }): void {
    const environment = captureInvestigationEnvironment();
    const handle = recorder.begin({ environment, operation });
    if (file !== undefined) {
      handle.setAudio({ role: 'source', audio: { status: 'retained', blob: file, format: file.type === 'audio/wav' || file.name.toLowerCase().endsWith('.wav') ? 'wav' : 'bin', description: 'Original source File retained by the UI; not decoded or native-consumed PCM' } });
    }
    current = {
      operationId,
      modelId,
      modelFile,
      phase,
      loadStarted: (() => {
        switch (phase) {
        case 'loading': return performance.now();
        case 'awaiting_run': case 'running': return undefined;
        default: {
          const exhaustive: never = phase;
          throw new Error(String(exhaustive));
        }
        }
      })(),
      inputStarted: undefined,
      estimate: createModelLoadEstimate(),
      lastEstimate: undefined,
      lastLoadStage: undefined,
      task: operation.task,
      handle,
      environment,
      operation,
      state: 'open',
    };
    changed({ id: handle.id });
  }
  function publish({ status }: { status: SpeechInvestigationStatus | undefined }): void {
    if (!current || current.state === 'finished') {
      return;
    }
    if (status !== undefined) {
      current.handle.finish({ status, environment: current.environment, operation: current.operation });
      current.state = 'finished';
      current.phase = 'finished';
    }
  }
  function settleLoad({ state }: { state: 'completed' | 'failed' | 'cancelled' }): void {
    if (current === undefined) {
      return;
    }
    const elapsed = current.loadStarted === undefined ? undefined : performance.now() - current.loadStarted;
    const duration = elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
    current.operation.measurements = { ...current.operation.measurements, modelLoad: measured({ value: duration, unit: 'milliseconds', boundary: 'App load invocation through settlement; includes runtime/preparation/native load and failure/cancellation' }) };
    current.handle.record({ event: { kind: 'stage', stage: 'app_model_load', state, durationMilliseconds: duration, heapBytes: undefined, details: undefined } });
  }
  function settleInputCapture({ state }: { state: 'failed' | 'cancelled' }): void {
    if (current === undefined) {
      return;
    }
    const elapsed = current.inputStarted === undefined ? undefined : performance.now() - current.inputStarted;
    const duration = elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
    current.operation.measurements = { ...current.operation.measurements, inputCapture: measured({ value: duration, unit: 'milliseconds', boundary: 'App prepareRun through input-capture failure/cancellation; native inference has not started' }) };
    current.handle.record({ event: { kind: 'stage', stage: 'input_capture', state, durationMilliseconds: duration, heapBytes: undefined, details: undefined } });
  }
  function fileRunIsTerminal({ stage }: { stage: SpeechFileRunState['stage'] }): boolean {
    switch (stage) {
    case 'finished': return true;
    case 'preparing_input': case 'starting_dialogue': case 'feeding_input': case 'draining_input': case 'saving_output': return false;
    default: {
      const exhaustive: never = stage;
      throw new Error(String(exhaustive));
    }
    }
  }
  function matching({ context }: { context: SpeechInvestigationContext }): boolean {
    return context.source === 'investigation' && current?.handle.id === context.operationId && current.state === 'open';
  }
  function observe({ context, event }: { context: SpeechInvestigationContext, event: SpeechInvestigationEvent }): void {
    if (!matching({ context }) || current === undefined) {
      return;
    }
    current.handle.record({ event });
    switch (event.kind) {
    case 'model_info':
      current.operation.effective = { ...current.operation.effective, device: event.device, threads: event.threads };
      break;
    case 'failure': current.operation.failure = observed({ value: event.failure, source: `Native observation at ${event.stage}` });
      break;
    case 'stage': {
      const runtime = current.environment.runtime;
      if (event.stage === 'runtime_integrity_verified' && event.state === 'completed' && runtime.status === 'observed' && event.details?.wasmSha256 === runtime.value.wasmSha256 && event.details.schemaSha256 === runtime.value.schemaSha256) {
        current.environment.runtime = observed({ value: { ...runtime.value, wasmVerification: 'verified' }, source: 'Matching Worker artifact hashes after mandatory loadSpeechCore raw-Wasm/schema/ABI checks' });
      }
      break;
    }
    case 'native_log': case 'native_log_batch': case 'progress': case 'devices': case 'read_summary': case 'wasm_heap': case 'result': case 'cancel': break;
    default: {
      const exhaustive: never = event;
      throw new Error(String(exhaustive));
    }
    }
  }
  function binding(): SpeechInvestigationBinding {
    if (current === undefined) {
      throw new Error('No current speech investigation');
    }
    const context: SpeechInvestigationContext = { operationId: current.handle.id, source: 'investigation' };
    return { context, observer: ({ event }) => observe({ context, event }) };
  }
  return {
    beginLoad({ task, modelId, model, file }: { task: SpeechInvestigationOperation['task'], modelId: string, model: SpeechModelInfo | SpeechRecognitionCandidateInfo, file: File | undefined }): SpeechInvestigationBinding {
      const operation = initialOperation({ task, modelId, model, modelFile: file, file: undefined, recording: false, language: undefined, seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined });
      operation.model.info = observed({ value: { architecture: model.architecture, task: model.task, sampleRate: model.sampleRate, requiredVersion: model.requiredVersion }, source: 'Parsed selected GGUF metadata before native load; not evidence of a loaded model' });
      operation.measurements = { modelLoad: measured({ value: undefined, unit: 'milliseconds', boundary: 'App model-load invocation has not settled' }) };
      begin({ operationId: undefined, modelId, modelFile: file, operation, file: undefined, phase: 'loading' });
      current?.handle.record({ event: { kind: 'stage', stage: 'app_model_load', state: 'started', durationMilliseconds: undefined, heapBytes: undefined, details: { selectedName: model.name, selectedBytes: model.bytes, selectedMetadataSource: 'Parsed GGUF header at load acceptance' } } });
      return binding();
    },
    loadProgress({ context, progress }: { context: SpeechInvestigationContext, progress: SpeechLoadProgress | undefined }): void {
      if (!matching({ context }) || current?.phase !== 'loading') {
        return;
      }
      if (progress !== undefined && current.lastLoadStage !== progress.stage) {
        current.lastLoadStage = progress.stage;
        current.handle.record({ event: { kind: 'stage', stage: `app_load_${progress.stage}`, state: 'started', durationMilliseconds: undefined, heapBytes: undefined, details: undefined } });
      }
      const value = current.estimate.update({ progress, ready: false });
      const integer = value === undefined ? undefined : Math.floor(value);
      if (integer !== undefined && integer !== current.lastEstimate) {
        current.lastEstimate = integer;
        current.handle.record({ event: { kind: 'progress', stage: 'overall_model_load_estimate', value: integer, total: 100, unit: 'estimated_work', provenance: 'estimated', details: { method: modelLoadEstimateMethod, stageWeights: modelLoadStageWeights } } });
      }
    },
    loaded({ context, model, file }: { context: SpeechInvestigationContext, model: SpeechModelInfo | SpeechRecognitionModelInfo, file: File }): void {
      if (!matching({ context }) || current?.phase !== 'loading' || model.task !== current.task) {
        return;
      }
      current.modelFile = file;
      current.operation.model = { ...current.operation.model, name: model.name, bytes: model.bytes, info: observed({ value: { architecture: model.architecture, task: model.task, sampleRate: model.sampleRate, requiredVersion: model.requiredVersion }, source: 'Public loaded model description' }) };
      settleLoad({ state: 'completed' });
      publish({ status: 'completed' });
    },
    loadFailed({ context, failure }: { context: SpeechInvestigationContext, failure: SpeechFailure }): void {
      if (!matching({ context }) || current?.phase !== 'loading') {
        return;
      }
      current.operation.failure = observed({ value: failure, source: 'App model-load failure' });
      current.handle.record({ event: { kind: 'failure', stage: 'app_model_load', failure } });
      settleLoad({ state: 'failed' });
      publish({ status: 'failed' });
    },
    loadCancelled({ context, reason }: { context: SpeechInvestigationContext, reason: string }): void {
      if (!matching({ context }) || current?.phase !== 'loading') {
        return;
      }
      current.handle.record({ event: { kind: 'cancel', state: 'settled', reason } });
      switch (current.operation.failure.status) {
      case 'observed': settleLoad({ state: 'failed' });
        publish({ status: 'failed' });
        break;
      case 'unset': case 'unknown': case 'unavailable': case 'not_applicable': settleLoad({ state: 'cancelled' });
        publish({ status: 'cancelled' });
        break;
      default: {
        const exhaustive: never = current.operation.failure;
        throw new Error(String(exhaustive));
      }
      }
    },
    prepareRun({ task, modelId, modelFile, model, file, recording, language, seed, maxSeconds, inputPacing, instructions }: { task: SpeechInvestigationOperation['task'], modelId: string, modelFile: File | undefined, model: SpeechModelInfo | SpeechRecognitionModelInfo, file: File | undefined, recording: boolean, language: string | undefined, seed: number | undefined, maxSeconds: number | undefined, inputPacing: SpeechFileRunState['inputPacing'] | undefined, instructions: string | undefined }): SpeechInvestigationBinding {
      const operation = initialOperation({ task, modelId, model, modelFile: undefined, file, recording, language, seed, maxSeconds, inputPacing, instructions });
      begin({ operationId: undefined, modelId, modelFile, operation, file, phase: 'awaiting_run' });
      if (current !== undefined) {
        current.inputStarted = performance.now();
      }
      return binding();
    },
    runFailed({ context, failure }: { context: SpeechInvestigationContext, failure: SpeechFailure }): void {
      if (!matching({ context }) || current?.phase !== 'awaiting_run') {
        return;
      }
      switch (current.operation.failure.status) {
      case 'observed': break;
      case 'unset': case 'unknown': case 'unavailable': case 'not_applicable':
        current.operation.failure = observed({ value: failure, source: 'App input capture before native run' });
        break;
      default: {
        const exhaustive: never = current.operation.failure;
        throw new Error(String(exhaustive));
      }
      }
      current.handle.record({ event: { kind: 'failure', stage: 'input_capture', failure } });
      settleInputCapture({ state: 'failed' });
      publish({ status: 'failed' });
    },
    runCancelled({ context, reason }: { context: SpeechInvestigationContext, reason: string }): void {
      if (!matching({ context }) || current?.phase !== 'awaiting_run') {
        return;
      }
      current.handle.record({ event: { kind: 'cancel', state: 'settled', reason } });
      switch (current.operation.failure.status) {
      case 'observed': settleInputCapture({ state: 'failed' });
        publish({ status: 'failed' });
        break;
      case 'unset': case 'unknown': case 'unavailable': case 'not_applicable': settleInputCapture({ state: 'cancelled' });
        publish({ status: 'cancelled' });
        break;
      default: {
        const exhaustive: never = current.operation.failure;
        throw new Error(String(exhaustive));
      }
      }
    },
    observe,
    audio({ context, role, audio }: { context: SpeechInvestigationContext, role: SpeechInvestigationAudioRole, audio: SpeechInvestigationAudio }): boolean {
      if (!matching({ context }) || current === undefined) {
        return false;
      }
      return current.handle.setAudio({ role, audio });
    },
    response({ run, modelId, model, file, instructions, beginRun }: { run: SpeechFileRunState, modelId: string, model: SpeechModelInfo | undefined, file: File, instructions: string | undefined, beginRun: boolean }): void {
      if (beginRun && model) {
        if (current?.phase === 'awaiting_run' && current.task === 'dialogue' && current.modelId === modelId) {
          current.operationId = run.id;
          current.phase = 'running';
        } else {
          begin({ operationId: run.id, modelId, modelFile: undefined, phase: 'running', file, operation: initialOperation({ task: 'dialogue', modelId, model, modelFile: undefined, file, recording: false, language: run.language, seed: run.seed, maxSeconds: run.maxSeconds, inputPacing: run.inputPacing, instructions }) });
        }
      }
      if (!current || current.task !== 'dialogue' || current.operationId !== run.id || current.state === 'finished') {
        return;
      }
      current.operation = {
        ...current.operation,
        processing: observed({ value: { audioRetention: { maximumBytes: run.audioRetention.maximumBytes, retainedBytes: run.audioRetention.retainedBytes, status: run.audioRetention.status, statisticsScope: 'Meters describe all client-accepted/native-received PCM; retained WAV may contain only a budget-limited prefix' }, sourceSamples: run.sourceSamples, paddingSamples: run.paddingSamples, submittedSamples: run.submittedSamples, plannedInputSamples: run.plannedInputSamples, requestedTailSeconds: run.requestedTailSeconds, effectiveTailSeconds: run.effectiveTailSeconds, inputLevel: { requested: inputLevelRequest({ requested: run.inputLevel.requested }), appliedGain: run.inputLevel.appliedGain, before: run.inputLevel.before, after: run.inputLevel.after, clippedSamples: run.inputLevel.clippedSamples, boundary: 'Decoded/downmixed/resampled source PCM before padding and tail; constant gain from requested mode, then clipping to [-1,1]' }, acceptedInputIsNotNativeConsumption: true, loadEstimate: { method: modelLoadEstimateMethod, stageWeights: modelLoadStageWeights } }, source: 'File controller actual source-level adjustment, padding and client-accepted input counters' }),
        result: { text: run.text, languages: [], completion: observed({ value: run.status, source: 'File controller status' }), input: observed({ value: run.inputStatistics, source: 'All client-accepted PCM, including queued samples; a budget-limited WAV may contain only a prefix' }), output: observed({ value: run.outputStatistics, source: 'All native-received PCM before playback; a budget-limited WAV may contain only a prefix' }), details: observed({ value: { frames: run.frames, firstSequence: run.firstSequence, lastSequence: run.lastSequence, sequenceDiscontinuities: run.sequenceDiscontinuities, nativeObservations: 'See events.jsonl; absent observations remain unknown' }, source: 'File controller output counters' }) },
        measurements: { ...current.operation.measurements, inputPreparation: measured({ value: run.inputPreparationMilliseconds, unit: 'milliseconds', boundary: 'File decoding/downmix/resampling and explicit source-level adjustment' }), firstOutput: measured({ value: run.firstOutputMilliseconds, unit: 'milliseconds', boundary: 'Native start invocation to first PCM callback, which may precede input' }), generation: measured({ value: run.generationMilliseconds, unit: 'milliseconds', boundary: 'Native start through stop settlement, including intentional input pacing' }), elapsed: measured({ value: run.elapsedMilliseconds, unit: 'milliseconds', boundary: 'File controller creation through latest state publication' }) },
        failure: run.failure ? observed({ value: run.failure, source: 'File controller failure' }) : current.operation.failure,
      };
      switch (run.status) {
      case 'decoding': case 'running': publish({ status: undefined });
        break;
      case 'complete': publish({ status: fileRunIsTerminal({ stage: run.stage }) ? 'completed' : undefined });
        break;
      case 'partial': publish({ status: fileRunIsTerminal({ stage: run.stage }) ? 'partial' : undefined });
        break;
      case 'failed': publish({ status: fileRunIsTerminal({ stage: run.stage }) ? 'failed' : undefined });
        break;
      default: {
        const exhaustive: never = run.status;
        throw new Error(String(exhaustive));
      }
      }
    },
    recognition({ run, modelId, model, file, language, recording, beginRun }: { run: SpeechRecognitionRun, modelId: string, model: SpeechRecognitionModelInfo | undefined, file: File | undefined, language: string | undefined, recording: boolean, beginRun: boolean }): void {
      if (beginRun && model) {
        if (current?.phase === 'awaiting_run' && current.task === 'recognition' && current.modelId === modelId) {
          current.operationId = run.id;
          current.phase = 'running';
        } else {
          begin({ operationId: run.id, modelId, modelFile: undefined, phase: 'running', file, operation: initialOperation({ task: 'recognition', modelId, model, modelFile: undefined, file, recording, language, seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined }) });
        }
      }
      if (!current || current.task !== 'recognition' || current.operationId !== run.id || current.state === 'finished') {
        return;
      }
      if (file !== undefined && current.operation.source.kind === 'unset') {
        current.operation.source = { kind: recording ? 'recording' : 'file', name: file.name, bytes: file.size, mediaType: file.type, captureRequested: recording ? unknown({ reason: 'Capture constraints were not forwarded to this record' }) : { status: 'not_applicable', reason: 'File input' }, captureActual: recording ? unknown({ reason: 'Actual MediaTrackSettings were not forwarded to this record' }) : { status: 'not_applicable', reason: 'File input' } };
        current.handle.setAudio({ role: 'source', audio: { status: 'retained', blob: file, format: file.type === 'audio/wav' || file.name.toLowerCase().endsWith('.wav') ? 'wav' : 'bin', description: 'Accepted recognition source File; decoded/submitted PCM remains a distinct boundary' } });
      }
      current.operation = {
        ...current.operation,
        processing: observed({ value: { inputSeconds: run.inputSeconds, nativeObservations: 'See events.jsonl; absent observations remain unknown' }, source: 'Recognition controller; detailed native input statistics unavailable' }),
        result: { ...current.operation.result, text: run.text, languages: run.languages, completion: observed({ value: run.status, source: 'Recognition controller status' }) },
        measurements: { ...current.operation.measurements, inputDuration: measured({ value: run.inputSeconds === undefined ? undefined : run.inputSeconds * 1000, unit: 'milliseconds', boundary: 'PCM duration accepted by recognition controller' }), inputPreparation: measured({ value: run.preparationSeconds === undefined ? undefined : run.preparationSeconds * 1000, unit: 'milliseconds', boundary: 'Recognition controller input preparation' }), recognition: measured({ value: run.recognitionSeconds === undefined ? undefined : run.recognitionSeconds * 1000, unit: 'milliseconds', boundary: 'Client transcribe call, including transfer and native input copy' }) },
        failure: run.failure ? observed({ value: run.failure, source: 'Recognition controller failure' }) : current.operation.failure,
      };
      switch (run.status) {
      case 'preparing': case 'recognizing': publish({ status: undefined });
        break;
      case 'complete': publish({ status: 'completed' });
        break;
      case 'cancelled': publish({ status: 'cancelled' });
        break;
      case 'model_limit': case 'max_seconds': publish({ status: 'partial' });
        break;
      case 'failed': publish({ status: 'failed' });
        break;
      default: {
        const exhaustive: never = run.status;
        throw new Error(String(exhaustive));
      }
      }
    },
    snapshot(): SpeechInvestigationSnapshot | undefined {
      if (current === undefined) {
        return undefined;
      }
      switch (current.state) {
      case 'open': return current.handle.checkpoint({ environment: current.environment, operation: current.operation });
      case 'finished': return recorder.snapshot();
      default: {
        const exhaustive: never = current.state;
        throw new Error(String(exhaustive));
      }
      }
    },
    clear(): void {
      current = undefined;
      recorder.clear();
      changed({ id: undefined });
    },
  };
}

export const TEST_ONLY = {
};
