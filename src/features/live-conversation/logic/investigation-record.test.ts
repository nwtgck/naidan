// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createInvestigationRecord } from './investigation-record';
import { collectionFromSnapshot, planFromSnapshot } from '@/features/speech-cpp-browser/investigation/investigation.test-support';
import { createSpeechInvestigationCollection } from '@/features/speech-cpp-browser/investigation/collection';
import { createSpeechInvestigationArchive } from '@/features/speech-cpp-browser/investigation/archive';
import type { SpeechRecognitionModelInfo } from '@/features/speech-cpp-browser/recognition/types';
import type { SpeechRecognitionRun } from '@/features/speech-cpp-browser/recognition/controller';
import { speechFileRunFixture } from './speech-file-run.test-support';

const configuration = vi.hoisted(() => ({ kind: 'available' as const, sourceCommit: 'a'.repeat(40), artifact: { profile: 'webgpu-wasm64-jspi' as const, modulePath: '/speech/core.mjs', wasmPath: '/speech/core.wasm.gz', helpersPath: '/speech/host.mjs', schemaSha256: 'b'.repeat(64), wasmSha256: 'c'.repeat(64), wasmBytes: 1234 } }));
vi.mock('virtual:speech-cpp-browser/config', () => ({ default: configuration }));

function fixture() {
  const changed = vi.fn();
  const record = createInvestigationRecord({ changed });
  const modelFile = new File(['MODEL WEIGHTS MUST NOT BE AUDIO'], 'model.gguf');
  const model: SpeechRecognitionModelInfo = { name: modelFile.name, bytes: modelFile.size, architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000, requiredVersion: '0.12.0', languages: ['ja'], languageSelection: 'supported' };
  const file = new File(['source audio'], 'greeting.wav', { type: 'audio/wav' });
  return { changed, record, modelFile, model, file };
}

function recognitionRun({ id, status }: { id: string, status: SpeechRecognitionRun['status'] }): SpeechRecognitionRun {
  return { id, modelName: 'model.gguf', inputName: 'greeting.wav', status, text: 'こんにちは', languages: ['ja'], inputSeconds: 1, preparationSeconds: 0.01, recognitionSeconds: 0.1, failure: undefined };
}

beforeEach(() => {
  vi.stubGlobal('__APP_VERSION__', 'test-version');
  vi.stubGlobal('__APP_SOURCE__', { sourceCommit: 'd'.repeat(40), workingTree: 'dirty' });
  vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', false);
  vi.stubGlobal('navigator', { userAgent: 'test browser', hardwareConcurrency: 4 });
  vi.stubGlobal('document', { visibilityState: 'visible' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('UI-owned speech investigation', () => {
  it('captures selection before File acquisition, load-only checkpoints and failure without retaining model weights as audio', async () => {
    const { record, model, modelFile } = fixture();
    const load = record.beginLoad({ task: 'recognition', modelId: 'selected', model, file: undefined });
    record.loadProgress({ context: load.context, progress: { stage: 'reading_model', readBytes: 5, totalBytes: 10 } });
    const checkpoint = record.snapshot()!;
    expect(checkpoint).toMatchObject({ status: 'in_progress', operation: { source: { kind: 'unset' }, model: { name: 'model.gguf', bytes: modelFile.size } } });
    expect(checkpoint.environment.app).toMatchObject({ sourceCommit: { value: 'd'.repeat(40) }, workingTree: { value: 'dirty' } });
    expect(checkpoint.environment.runtime).toMatchObject({ status: 'observed', value: { sourceCommit: configuration.sourceCommit, wasmVerification: 'manifest_only' } });
    expect(Object.values(checkpoint.audio).every(audio => audio.status !== 'retained')).toBe(true);
    const estimated = checkpoint.events.find(value => value.event.kind === 'progress');
    expect(estimated?.event).toMatchObject({ provenance: 'estimated', unit: 'estimated_work', details: { method: 'fixed_stage_weights' } });
    const failure = { code: 'invalid_model' as const, message: 'File acquisition failed before native load', nativeStatus: undefined, nativeInput: undefined };
    record.loadFailed({ context: load.context, failure });
    const failed = record.snapshot()!;
    expect(failed.status).toBe('failed');
    expect(failed.operation.failure).toMatchObject({ value: failure });
    expect(failed.operation.measurements.modelLoad?.value.status).toBe('observed');
    expect(failed.events.some(value => value.event.kind === 'stage' && value.event.stage === 'app_model_load' && value.event.state === 'failed')).toBe(true);
    const archive = createSpeechInvestigationArchive({ collection: collectionFromSnapshot({ snapshot: failed }), includeInputAudio: 'on', includeInputText: 'on', signal: new AbortController().signal });
    const zip = await JSZip.loadAsync(await new Response(archive.stream).arrayBuffer());
    expect(Object.keys(zip.files).some(name => name.startsWith('audio/'))).toBe(false);
    expect(await zip.file('load/operation.json')!.async('string')).not.toContain('MODEL WEIGHTS MUST NOT BE AUDIO');
    expect(checkpoint.status).toBe('in_progress');
  });

  it('keeps model loading once in a separate slot and gives every accepted trial a unique recorder ID', () => {
    const { record, modelFile, model, file } = fixture();
    const load = record.beginLoad({ task: 'recognition', modelId: 'selected', model, file: modelFile });
    load.observer({ event: { kind: 'stage', stage: 'runtime_integrity_verified', state: 'completed', durationMilliseconds: undefined, heapBytes: undefined, details: { wasmSha256: configuration.artifact.wasmSha256, schemaSha256: configuration.artifact.schemaSha256 } } });
    load.observer({ event: { kind: 'native_log', level: 'info', message: 'actual load detail' } });
    record.loaded({ context: load.context, model, file: modelFile });
    const loadSnapshot = record.snapshot()!;
    expect(loadSnapshot.status).toBe('completed');
    expect(loadSnapshot.environment.runtime).toMatchObject({ value: { wasmVerification: 'verified' } });
    const request = { task: 'recognition' as const, modelId: 'selected', modelFile, model, file, recording: false, language: 'ja', seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined };
    const binding = record.prepareRun(request);
    expect(binding.context.operationId).not.toBe(load.context.operationId);
    const collection = createSpeechInvestigationCollection({ plan: planFromSnapshot({ snapshot: record.snapshot()!, trials: [{ id: 'first', inputLevel: { status: 'not_applicable', reason: 'Recognition' } }] }), sourceAudio: record.snapshot()!.audio.source });
    collection.setLoad({ snapshot: loadSnapshot });
    collection.startTrial({ trialId: 'first' });
    record.recognition({ run: recognitionRun({ id: 'run1', status: 'preparing' }), modelId: 'selected', model, file, language: 'ja', recording: false, beginRun: true });
    binding.observer({ event: { kind: 'model_info', rawJson: '{"defaults":{"threads":4}}', device: { status: 'observed', value: 'GPU0', source: 'native' }, threads: { status: 'observed', value: 4, source: 'native' }, weightType: { status: 'observed', value: 'F16', source: 'native' }, weightBytes: { status: 'observed', value: '1000', source: 'native' } } });
    record.recognition({ run: recognitionRun({ id: 'run1', status: 'complete' }), modelId: 'selected', model, file, language: 'ja', recording: false, beginRun: false });
    const snapshot = record.snapshot()!;
    expect(snapshot.status).toBe('completed');
    expect(snapshot.operation.effective.device).toMatchObject({ value: 'GPU0' });
    expect(snapshot.operation.measurements.modelLoad?.value.status).toBe('unknown');
    expect(snapshot.events.some(value => value.event.kind === 'native_log' && value.event.message === 'actual load detail')).toBe(false);
    collection.completeTrial({ trialId: 'first', snapshot, retention: 'available' });
    const archived = collection.snapshot({ active: undefined })!;
    expect(archived.load?.id).toBe(load.context.operationId);
    expect(archived.load?.events.some(value => value.event.kind === 'native_log' && value.event.message === 'actual load detail')).toBe(true);
    expect(archived.trials[0]).toMatchObject({ status: 'completed', snapshot: { id: binding.context.operationId } });
    const rerun = record.prepareRun(request);
    expect(rerun.context.operationId).not.toBe(binding.context.operationId);
    load.observer({ event: { kind: 'native_log', level: 'error', message: 'late previous load' } });
    record.observe({ context: load.context, event: { kind: 'wasm_heap', capacityBytes: 123 } });
    expect(record.snapshot()!.events).toEqual([]);
    expect(archived.load?.events.some(value => value.event.kind === 'native_log' && value.event.message === 'actual load detail')).toBe(true);
  });

  it('keeps matching runtime hashes as evidence only for their independent load record', () => {
    const { record, modelFile, model, file } = fixture();
    const load = record.beginLoad({ task: 'recognition', modelId: 'selected', model, file: modelFile });
    load.observer({ event: { kind: 'stage', stage: 'runtime_integrity_verified', state: 'completed', durationMilliseconds: undefined, heapBytes: undefined, details: { wasmSha256: 'wrong', schemaSha256: configuration.artifact.schemaSha256 } } });
    record.loaded({ context: load.context, model, file: modelFile });
    expect(record.snapshot()!.environment.runtime).toMatchObject({ value: { wasmVerification: 'manifest_only' } });
    const sameNameDifferentFile = new File(['MODEL WEIGHTS MUST NOT BE AUDIO'], modelFile.name);
    const next = record.prepareRun({ task: 'recognition', modelId: 'selected', modelFile: sameNameDifferentFile, model, file, recording: false, language: undefined, seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined });
    expect(next.context.operationId).not.toBe(load.context.operationId);
    expect(record.snapshot()!.operation.measurements.modelLoad?.value.status).toBe('unknown');
    record.loadFailed({ context: load.context, failure: { code: 'runtime_failed', message: 'old failure', nativeStatus: 1, nativeInput: 'old load' } });
    expect(record.snapshot()!.status).toBe('in_progress');
    record.clear();
    next.observer({ event: { kind: 'native_log', level: 'info', message: 'after clear' } });
    expect(record.snapshot()).toBeUndefined();
  });

  it('binds a microphone attempt without a placeholder File and accepts source/audio only for its controller run', () => {
    const { record, model, file } = fixture();
    const binding = record.prepareRun({ task: 'recognition', modelId: 'selected', modelFile: undefined, model, file: undefined, recording: true, language: 'ja', seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined });
    record.recognition({ run: recognitionRun({ id: 'mic1', status: 'preparing' }), modelId: 'selected', model, file: undefined, language: 'ja', recording: true, beginRun: true });
    expect(record.snapshot()!.operation.source.kind).toBe('unset');
    record.recognition({ run: recognitionRun({ id: 'unrelated', status: 'recognizing' }), modelId: 'selected', model, file, language: 'ja', recording: true, beginRun: false });
    expect(record.snapshot()!.operation.source.kind).toBe('unset');
    record.recognition({ run: recognitionRun({ id: 'mic1', status: 'recognizing' }), modelId: 'selected', model, file, language: 'ja', recording: true, beginRun: false });
    const input = new Blob(['exact accepted input']);
    expect(record.audio({ context: binding.context, role: 'input', audio: { status: 'retained', blob: input, format: 'wav', description: 'Client-accepted PCM; queued does not prove native consumption' } })).toBe(true);
    record.recognition({ run: recognitionRun({ id: 'mic1', status: 'cancelled' }), modelId: 'selected', model, file, language: 'ja', recording: true, beginRun: false });
    const snapshot = record.snapshot()!;
    expect(snapshot).toMatchObject({ status: 'cancelled', operation: { source: { kind: 'recording', name: file.name } } });
    expect(snapshot.audio.input).toMatchObject({ status: 'retained', blob: input });
    expect(record.audio({ context: binding.context, role: 'input', audio: { status: 'unavailable', reason: 'too late' } })).toBe(false);
    expect(record.snapshot()!.audio.input).toMatchObject({ status: 'retained', blob: input });
  });

  it.each(['cancelled', 'failed'] as const)('settles cancelled model loading as %s while retaining an observed native failure', status => {
    const { record, model, modelFile } = fixture();
    const load = record.beginLoad({ task: 'recognition', modelId: 'selected', model, file: modelFile });
    const failure = { code: 'runtime_failed' as const, message: 'Native load failed during cancellation', nativeStatus: 7, nativeInput: 'speech_model_load' };
    if (status === 'failed') {
      load.observer({ event: { kind: 'failure', stage: 'speech_model_load', failure } });
    }
    record.loadCancelled({ context: load.context, reason: 'Explicit user cancellation after controller settlement' });
    const snapshot = record.snapshot()!;
    expect(snapshot.status).toBe(status);
    expect(snapshot.operation.measurements.modelLoad?.value.status).toBe('observed');
    expect(snapshot.events.some(value => value.event.kind === 'stage' && value.event.stage === 'app_model_load' && value.event.state === status)).toBe(true);
    if (status === 'failed') {
      expect(snapshot.operation.failure).toMatchObject({ value: failure });
    }
  });

  it.each(['failed', 'cancelled'] as const)('settles a microphone capture %s before native-run acceptance and keeps old contexts isolated', status => {
    const { record, model } = fixture();
    const request = { task: 'recognition' as const, modelId: 'selected', modelFile: undefined, model, file: undefined, recording: true, language: 'ja', seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined };
    const old = record.prepareRun(request);
    const binding = record.prepareRun(request);
    const failure = { code: 'runtime_failed' as const, message: 'Microphone permission or audio flush failed', nativeStatus: undefined, nativeInput: undefined };
    record.runFailed({ context: old.context, failure });
    record.runCancelled({ context: old.context, reason: 'Old capture discarded' });
    expect(record.snapshot()!.status).toBe('in_progress');
    if (status === 'failed') {
      record.runFailed({ context: binding.context, failure });
    } else {
      record.runCancelled({ context: binding.context, reason: 'Stopped while permission was pending; no clip produced' });
    }
    const snapshot = record.snapshot()!;
    expect(snapshot.status).toBe(status);
    expect(snapshot.operation.source.kind).toBe('unset');
    expect(snapshot.operation.measurements.inputCapture?.value.status).toBe('observed');
    expect(snapshot.events.some(value => value.event.kind === 'stage' && value.event.stage === 'input_capture' && value.event.state === status)).toBe(true);
    expect(snapshot.events.some(value => value.event.kind === 'result')).toBe(false);
    expect(snapshot.operation.result.completion.status).toBe('unknown');
    if (status === 'failed') {
      expect(snapshot.operation.failure).toMatchObject({ value: failure });
    } else {
      expect(snapshot.operation.failure.status).toBe('unset');
    }
    record.runFailed({ context: binding.context, failure });
    expect(record.snapshot()).toBe(snapshot);
  });

  it.each(['failure', 'cancel'] as const)('preserves an observed native failure when pre-run input capture receives %s', method => {
    const { record, model } = fixture();
    const binding = record.prepareRun({ task: 'recognition', modelId: 'selected', modelFile: undefined, model, file: undefined, recording: true, language: 'ja', seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined });
    const native = { code: 'runtime_failed' as const, message: 'Native failure', nativeStatus: 17, nativeInput: 'native diagnostic detail' };
    binding.observer({ event: { kind: 'failure', stage: 'native', failure: native } });
    if (method === 'failure') {
      record.runFailed({ context: binding.context, failure: { code: 'runtime_failed', message: 'Later capture failure', nativeStatus: undefined, nativeInput: undefined } });
    } else {
      record.runCancelled({ context: binding.context, reason: 'Discard while capturing' });
    }
    expect(record.snapshot()).toMatchObject({ status: 'failed', operation: { failure: { value: native } } });
  });

  it('leaves accepted native runs to their controller terminal status', () => {
    const { record, model, file } = fixture();
    const binding = record.prepareRun({ task: 'recognition', modelId: 'selected', modelFile: undefined, model, file, recording: true, language: 'ja', seed: undefined, maxSeconds: undefined, inputPacing: undefined, instructions: undefined });
    record.recognition({ run: recognitionRun({ id: 'accepted', status: 'recognizing' }), modelId: 'selected', model, file, language: 'ja', recording: true, beginRun: true });
    record.runCancelled({ context: binding.context, reason: 'Old capture completion' });
    record.runFailed({ context: binding.context, failure: { code: 'runtime_failed', message: 'Late capture exception', nativeStatus: undefined, nativeInput: undefined } });
    expect(record.snapshot()!.status).toBe('in_progress');
    record.recognition({ run: recognitionRun({ id: 'accepted', status: 'complete' }), modelId: 'selected', model, file, language: 'ja', recording: true, beginRun: false });
    expect(record.snapshot()!.status).toBe('completed');
    expect(record.snapshot()!.operation.failure.status).toBe('unset');
  });

  it('retains real file-run input/output Blobs before terminal publication without URL readback', async () => {
    await using fileRun = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, pcm: new Float32Array(3200), tailSeconds: 0, maxSeconds: 2, inputPacing: 'fast' });
    const record = createInvestigationRecord({ changed() {} });
    const model = fileRun.client.getState().model!;
    const file = new File(['source'], 'greeting.wav');
    const binding = record.prepareRun({ task: 'dialogue', modelId: 'haru', modelFile: undefined, model, file, recording: false, language: 'ja', seed: 0, maxSeconds: 2, inputPacing: 'fast', instructions: 'private persona' });
    record.response({ run: fileRun.runner.getState(), modelId: 'haru', model, file, instructions: 'private persona', beginRun: true });
    await fileRun.runner.run();
    expect(fileRun.blobs).toHaveLength(2);
    record.audio({ context: binding.context, role: 'input', audio: { status: 'retained', blob: fileRun.blobs[0]!, format: 'wav', description: 'File-run accepted input' } });
    record.audio({ context: binding.context, role: 'output', audio: { status: 'retained', blob: fileRun.blobs[1]!, format: 'wav', description: 'Native output before playback' } });
    record.response({ run: fileRun.runner.getState(), modelId: 'haru', model, file, instructions: undefined, beginRun: false });
    expect(record.snapshot()).toMatchObject({ status: 'completed', operation: { result: { text: 'Initial response' }, requested: { seed: { value: 0 } }, privateInputs: { persona: 'private persona' } } });
    expect(record.snapshot()!.audio.output).toMatchObject({ status: 'retained', blob: fileRun.blobs[1] });
    fileRun.runner.clear();
    expect(record.snapshot()!.audio.output.status).toBe('retained');
  });

  it.each([
    { inputLevel: { kind: 'gain' as const, gain: 8 }, appliedGain: 8, peak: 1, clippedSamples: 2 },
    { inputLevel: { kind: 'peak' as const, targetPeak: 0.8 }, appliedGain: 3.2, peak: Math.fround(0.8), clippedSamples: 0 },
  ])('records actual $inputLevel.kind processing and keeps original source distinct from adjusted input', async ({ inputLevel, appliedGain, peak, clippedSamples }) => {
    await using fileRun = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel, pcm: new Float32Array([0.25, -0.25]), tailSeconds: 0, maxSeconds: 2, inputPacing: 'fast' });
    const record = createInvestigationRecord({ changed() {} }), model = fileRun.client.getState().model!;
    const file = new File(['original-source'], 'source.wav');
    const binding = record.prepareRun({ task: 'dialogue', modelId: 'haru', modelFile: undefined, model, file, recording: false, language: 'ja', seed: 0, maxSeconds: 2, inputPacing: 'fast', instructions: undefined });
    record.response({ run: fileRun.runner.getState(), modelId: 'haru', model, file, instructions: undefined, beginRun: true });
    await fileRun.runner.run();
    const input = fileRun.runner.getAudio({ role: 'input' })!;
    record.audio({ context: binding.context, role: 'input', audio: { status: 'retained', blob: input, format: 'wav', description: 'Adjusted client-accepted PCM with padding' } });
    record.response({ run: fileRun.runner.getState(), modelId: 'haru', model, file, instructions: undefined, beginRun: false });
    const snapshot = record.snapshot()!;
    expect(snapshot).toMatchObject({ status: 'completed', operation: { processing: { status: 'observed', value: { inputLevel: { requested: inputLevel, appliedGain, before: { samples: 2, peak: 0.25 }, after: { samples: 2, peak }, clippedSamples } } }, result: { input: { value: { samples: 3200 } } } } });
    expect(snapshot.audio.source).toMatchObject({ status: 'retained', blob: file });
    expect(snapshot.audio.input).toMatchObject({ status: 'retained', blob: input });
    expect(await file.text()).toBe('original-source');
    const wav = new DataView(await input.arrayBuffer());
    expect(wav.getFloat32(44, true)).toBe(peak);
    expect(wav.getFloat32(48, true)).toBe(-peak);
    expect(wav.getFloat32(52, true)).toBe(0);
  });

  it('records a rejected nonfinite request honestly without inventing gain or source measurements', async () => {
    await using fileRun = await speechFileRunFixture({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain', gain: NaN }, pcm: new Float32Array([0.25]), tailSeconds: 0, maxSeconds: 2, inputPacing: 'fast' });
    const record = createInvestigationRecord({ changed() {} }), model = fileRun.client.getState().model!;
    const file = new File(['source'], 'source.wav');
    record.prepareRun({ task: 'dialogue', modelId: 'haru', modelFile: undefined, model, file, recording: false, language: 'ja', seed: 0, maxSeconds: 2, inputPacing: 'fast', instructions: undefined });
    record.response({ run: fileRun.runner.getState(), modelId: 'haru', model, file, instructions: undefined, beginRun: true });
    await fileRun.runner.run();
    record.response({ run: fileRun.runner.getState(), modelId: 'haru', model, file, instructions: undefined, beginRun: false });
    expect(record.snapshot()).toMatchObject({ status: 'failed', operation: { processing: { value: { inputLevel: { requested: { kind: 'gain', gain: 'NaN' }, appliedGain: undefined, before: undefined, after: undefined, clippedSamples: undefined } } }, failure: { value: { message: 'Input gain must be a finite positive number' } } } });
  });
});
