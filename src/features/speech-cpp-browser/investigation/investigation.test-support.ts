import { createSpeechInvestigationCollection } from './collection';
import { createSpeechInvestigationRecorder } from './recorder';
import type { SpeechInvestigationEnvironment, SpeechInvestigationOperation, SpeechObservation } from './types';

export function observed<T>({ value }: { value: T }): SpeechObservation<T> {
  return { status: 'observed', value, source: 'Test observation' };
}

export function unknownObservation(): { status: 'unknown', reason: string } {
  return { status: 'unknown', reason: 'Not available through this API' };
}

export function investigationFixture({ task }: { task: SpeechInvestigationOperation['task'] }) {
  let clock = 100;
  const environment: SpeechInvestigationEnvironment = {
    app: { version: 'test', sourceCommit: observed({ value: 'app-commit' }), workingTree: observed({ value: 'dirty' }), mode: 'hosted' },
    runtime: observed({ value: { sourceCommit: 'runtime-commit', profile: 'webgpu-wasm64-jspi', variant: 'browser', wasmSha256: 'wasm-sha', wasmBytes: 123, schemaSha256: 'schema-sha', wasmVerification: 'verified', assetOrigin: observed({ value: 'installed artifact' }) } }),
    browser: { userAgent: observed({ value: 'test browser' }), hardwareConcurrency: observed({ value: 8 }), crossOriginIsolated: observed({ value: true }), visibility: observed({ value: 'visible' }), timeOrigin: observed({ value: 42 }) },
    gpuDevice: { status: 'unavailable', reason: 'No actual adapter observation hook' },
  };
  const settings = { language: observed({ value: 'ja' }), seed: observed({ value: 0 }), maxSeconds: observed({ value: 30 }), inputPacing: observed({ value: 'real_time' as const }), device: unknownObservation(), threads: unknownObservation(), warmup: unknownObservation() };
  const taskValues = (() => {
    switch (task) {
    case 'dialogue': return { architecture: 'haru', text: 'こんにちは。response', output: unknownObservation() };
    case 'recognition': return { architecture: 'qwen3-asr', text: '認識した文章', output: { status: 'not_applicable' as const, reason: 'Recognition produces text' } };
    default: {
      const unhandled: never = task;
      throw new Error(`Unhandled task: ${unhandled}`);
    }
    }
  })();
  const operation: SpeechInvestigationOperation = {
    task,
    model: { id: observed({ value: 'selected-model' }), name: 'model.gguf', bytes: 4096, source: 'local_file', info: observed({ value: { architecture: taskValues.architecture, requiredVersion: '0.12.0' } }) },
    source: { kind: 'file', name: '../../こんにちは.wav', bytes: 50, mediaType: 'audio/wav', captureRequested: { status: 'not_applicable', reason: 'File input' }, captureActual: { status: 'not_applicable', reason: 'File input' } },
    requested: settings,
    effective: settings,
    processing: observed({ value: { sampleRate: 24000, acceptedSamples: 3200, nativeProcessedSamples: undefined, tailSeconds: 5 } }),
    result: { text: taskValues.text, languages: ['ja'], completion: observed({ value: 'complete' }), input: observed({ value: { sampleRate: 24000, samples: 3, seconds: 3 / 24000, peak: 1, rms: 0.8, clippedSamples: 2 } }), output: taskValues.output, details: observed({ value: { stop: 'eog' } }) },
    measurements: { generation: { value: observed({ value: 1234 }), unit: 'milliseconds', boundary: 'Native start invocation through native stop settlement, including paced input' } },
    failure: observed({ value: { code: 'runtime_failed', message: 'Detailed native failure', nativeStatus: 7, nativeInput: 'dialogue_end: internal detail' } }),
    privateInputs: { persona: 'private persona', instructions: 'private instructions', name: 'private character' },
  };
  const recorder = createSpeechInvestigationRecorder({ now: () => clock, nowIso: () => '2026-11-16T00:00:00.000Z' });
  const run = recorder.begin({ environment, operation });
  return {
    environment,
    operation,
    recorder,
    run,
    clock({ value }: { value: number }): void {
      clock = value;
    },
  };
}

/** Small, valid mono/24 kHz/16-bit PCM with three exact samples. */
export function waveBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(50);
  const data = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  data.setUint32(4, 42, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, 24000, true);
  data.setUint32(28, 48000, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  data.setUint32(40, 6, true);
  data.setInt16(44, -32768, true);
  data.setInt16(46, 0, true);
  data.setInt16(48, 32767, true);
  return bytes;
}



export function planFromSnapshot({ snapshot, trials }: { snapshot: import('./types').SpeechInvestigationSnapshot, trials: import('./types').SpeechInvestigationTrialPlan[] }): import('./types').SpeechInvestigationPlan {
  const { operation } = snapshot;
  return { task: operation.task, model: operation.model, source: operation.source, requested: operation.requested, tailSeconds: observed({ value: 5 }), privateInputs: { persona: operation.privateInputs.persona === undefined ? 'unset' : 'set', instructions: operation.privateInputs.instructions === undefined ? 'unset' : 'set', name: operation.privateInputs.name === undefined ? 'unset' : 'set' }, trials };
}

export function collectionFromSnapshot({ snapshot }: { snapshot: import('./types').SpeechInvestigationSnapshot }): import('./types').SpeechInvestigationCollectionSnapshot {
  const loading = snapshot.operation.source.kind === 'unset';
  const collection = createSpeechInvestigationCollection({ plan: planFromSnapshot({ snapshot, trials: loading ? [] : [{ id: 'trial-1', inputLevel: { status: 'not_applicable', reason: 'Single-operation fixture' } }] }), sourceAudio: snapshot.audio.source });
  if (loading) {
    collection.setLoad({ snapshot });
  } else {
    collection.startTrial({ trialId: 'trial-1' });
    switch (snapshot.status) {
    case 'in_progress': return collection.snapshot({ active: { trialId: 'trial-1', snapshot } })!;
    case 'completed': case 'partial': case 'cancelled': case 'failed': break;
    default: {
      const exhaustive: never = snapshot.status;
      throw new Error(String(exhaustive));
    }
    }
    collection.completeTrial({ trialId: 'trial-1', snapshot, retention: 'available' });
  }
  return collection.snapshot({ active: undefined })!;
}

export const TEST_ONLY = {
};
