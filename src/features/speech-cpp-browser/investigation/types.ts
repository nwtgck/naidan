import type { SpeechFailure } from '@/features/speech-cpp-browser/types';

export type SpeechInvestigationJson = string | number | boolean | undefined | readonly SpeechInvestigationJson[] | { readonly [key: string]: SpeechInvestigationJson };
export type SpeechInvestigationJsonObject = { readonly [key: string]: SpeechInvestigationJson };
export type SpeechObservation<T> = { status: 'observed', value: T, source: string } | { status: 'unknown' | 'unavailable' | 'not_applicable' | 'unset', reason: string };
export type SpeechInvestigationStatus = 'completed' | 'partial' | 'cancelled' | 'failed';
export type SpeechInvestigationAudioRole = 'source' | 'input' | 'output';
export type SpeechInvestigationAudio = { status: 'retained', blob: Blob, format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'aac' | 'webm' | 'bin', description: string } | { status: 'unavailable' | 'not_applicable', reason: string };

export type SpeechInvestigationEnvironment = {
  app: { version: string, sourceCommit: SpeechObservation<string>, workingTree: SpeechObservation<'clean' | 'dirty'>, mode: 'hosted' | 'standalone' },
  runtime: SpeechObservation<{
    sourceCommit: string, profile: 'webgpu-wasm64-jspi', variant: 'browser' | 'test',
    wasmSha256: string, wasmBytes: number, schemaSha256: string,
    wasmVerification: 'verified' | 'manifest_only', assetOrigin: SpeechObservation<string>,
  }>,
  browser: { userAgent: SpeechObservation<string>, hardwareConcurrency: SpeechObservation<number>, crossOriginIsolated: SpeechObservation<boolean>, visibility: SpeechObservation<'visible' | 'hidden'>, timeOrigin: SpeechObservation<number> },
  /** Only the adapter/device actually used by this runtime; never a new probe. */
  gpuDevice: SpeechObservation<{ vendor: string, device: string, architecture: string, description: string, features: readonly string[], limits: Readonly<Record<string, number>> }>,
};

export type SpeechInvestigationSettings = {
  language: SpeechObservation<string>, seed: SpeechObservation<number>, maxSeconds: SpeechObservation<number>,
  inputPacing: SpeechObservation<'fast' | 'real_time'>, device: SpeechObservation<string>,
  threads: SpeechObservation<number>, warmup: SpeechObservation<boolean>,
};
export type SpeechInvestigationAudioStatistics = { sampleRate: number, samples: number, seconds: number, peak: number, rms: number, clippedSamples: number };
export type SpeechInvestigationMeasurement = { value: SpeechObservation<number>, unit: 'milliseconds' | 'bytes' | 'samples' | 'ratio' | 'count', boundary: string };
export type SpeechInvestigationOperation = {
  task: 'dialogue' | 'recognition',
  model: { id: SpeechObservation<string>, name: string, bytes: number, source: string, info: SpeechObservation<SpeechInvestigationJsonObject> },
  source: { kind: 'unset', reason: string } | { kind: 'file' | 'recording', name: string, bytes: number, mediaType: string, captureRequested: SpeechObservation<SpeechInvestigationJsonObject>, captureActual: SpeechObservation<SpeechInvestigationJsonObject> },
  requested: SpeechInvestigationSettings,
  effective: SpeechInvestigationSettings,
  /** Observed decode/downmix/resample, padding/tail and accepted-sample scope. */
  processing: SpeechObservation<SpeechInvestigationJsonObject>,
  result: { text: string, languages: readonly string[], completion: SpeechObservation<string>, input: SpeechObservation<SpeechInvestigationAudioStatistics>, output: SpeechObservation<SpeechInvestigationAudioStatistics>, details: SpeechObservation<SpeechInvestigationJsonObject> },
  measurements: Readonly<Record<string, SpeechInvestigationMeasurement>>,
  failure: SpeechObservation<SpeechFailure>,
  privateInputs: { persona: string | undefined, instructions: string | undefined, name: string | undefined },
};

export type SpeechInvestigationEvent =
  | { kind: 'native_log', level: string, message: string }
  | { kind: 'native_log_batch', lines: readonly { level: string, text: string }[], dropped: number }
  | { kind: 'stage', stage: string, state: 'started' | 'completed' | 'cancelled' | 'failed', durationMilliseconds: number | undefined, heapBytes: number | undefined, details: SpeechInvestigationJsonObject | undefined }
  | { kind: 'progress', stage: string, value: number, total: number | undefined, unit: 'bytes' | 'fraction' | 'samples' | 'estimated_work', provenance: 'observed' | 'estimated', details: SpeechInvestigationJsonObject | undefined }
  | { kind: 'model_info', rawJson: string, device: SpeechObservation<string>, threads: SpeechObservation<number>, weightType: SpeechObservation<string>, weightBytes: SpeechObservation<string> }
  | { kind: 'devices', devices: readonly { name: string, description: string, kind: string, totalBytes: SpeechObservation<string>, freeBytes: SpeechObservation<string> }[] }
  | { kind: 'read_summary', calls: number, totalBytes: number, uniqueBytes: SpeechObservation<number>, maximumChunkBytes: number, smallReads: number, elapsedMilliseconds: number | undefined }
  | { kind: 'wasm_heap', capacityBytes: number }
  | { kind: 'result', nativeStatus: number | undefined, stop: SpeechObservation<string | number>, seed: SpeechObservation<string>, details: SpeechInvestigationJsonObject | undefined }
  | { kind: 'cancel', state: 'requested' | 'settled', reason: string }
  | { kind: 'failure', stage: string, failure: SpeechFailure };
export type SpeechInvestigationObserver = ({ event }: { event: SpeechInvestigationEvent }) => void;
export type SpeechInvestigationRecordedEvent = { sequence: number, atMilliseconds: SpeechObservation<number>, event: SpeechInvestigationEvent, truncatedCodeUnits: number };

export const speechInvestigationLimits = {
  runs: 1,
  events: 512,
  metadataBytes: 512 * 1024,
  eventBytes: 512 * 1024,
  resultTextBytes: 256 * 1024,
  privateTextBytes: 64 * 1024,
  logTextBytes: 16 * 1024,
  audioBytes: 64 * 1024 * 1024,
} as const;

export type SpeechInvestigationCapture = {
  eventBytes: number, metadataBytes: number, audioBytes: number,
  droppedEvents: number, droppedEventBytes: number, rejectedMetadataUpdates: number,
  truncatedCodeUnits: number, clockAnomalies: number,
  latestMetadata: 'accepted' | 'rejected',
};
export type SpeechInvestigationSnapshot = {
  id: string, startedAt: string, capturedAt: string, finishedAt: string | undefined, status: SpeechInvestigationStatus | 'in_progress',
  elapsedMilliseconds: SpeechObservation<number>,
  environment: SpeechInvestigationEnvironment,
  operation: SpeechInvestigationOperation,
  events: readonly SpeechInvestigationRecordedEvent[],
  audio: Readonly<Record<SpeechInvestigationAudioRole, SpeechInvestigationAudio>>,
  capture: SpeechInvestigationCapture,
};

export type SpeechInvestigationExportOptions = { includeInputAudio: 'on' | 'off', includeInputText: 'on' | 'off' };



export type SpeechInvestigationTrialPlan = {
  id: string,
  inputLevel: SpeechObservation<import('@/features/live-conversation/logic/audio-level').SpeechInputLevelSettings>,
};
export type SpeechInvestigationPlan = {
  task: SpeechInvestigationOperation['task'],
  model: SpeechInvestigationOperation['model'],
  source: SpeechInvestigationOperation['source'],
  requested: SpeechInvestigationSettings,
  tailSeconds: SpeechObservation<number>,
  privateInputs: { persona: 'set' | 'unset', instructions: 'set' | 'unset', name: 'set' | 'unset' },
  trials: readonly SpeechInvestigationTrialPlan[],
};
export type SpeechInvestigationTrial =
  | { id: string, index: number, status: 'not_run', reason: string }
  | { id: string, index: number, status: SpeechInvestigationSnapshot['status'], snapshot: SpeechInvestigationSnapshot | undefined, capture: { status: 'complete' | 'partial', reason: string | undefined } };
export type SpeechInvestigationCollectionSnapshot = {
  id: string, createdAt: string, capturedAt: string,
  status: SpeechInvestigationSnapshot['status'],
  plan: SpeechInvestigationPlan,
  load: SpeechInvestigationSnapshot | undefined,
  sourceAudio: SpeechInvestigationAudio,
  trials: readonly SpeechInvestigationTrial[],
  capture: { audioBytes: number, metadataBytes: number, limitReason: string | undefined },
};
export const speechInvestigationCollectionLimits = {
  trials: 6,
  planBytes: 512 * 1024,
  metadataBytes: 8 * 1024 * 1024,
  audioBytes: 64 * 1024 * 1024,
  zipBytes: 74 * 1024 * 1024,
} as const;

export const TEST_ONLY = {
};
