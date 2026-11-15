// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { investigationFixture, observed } from './investigation.test-support';
import { speechInvestigationLimits } from './types';

describe('speech investigation recorder', () => {
  it('owns immutable terminal metadata and Blob references across clear, replacement and late callbacks', () => {
    const fixture = investigationFixture({ task: 'dialogue' });
    const { environment, operation, recorder, run } = fixture;
    const blob = new Blob(['output']);
    expect(run.setAudio({ role: 'output', audio: { status: 'retained', blob, format: 'wav', description: 'Pre-playback generated PCM' } })).toBe(true);
    const info = { device: 'actual GPU' };
    expect(run.record({ event: { kind: 'model_info', rawJson: JSON.stringify(info), device: observed({ value: info.device }), threads: observed({ value: 4 }), weightType: observed({ value: 'Q8_0' }), weightBytes: observed({ value: '8589934592' }) } })).toBe(true);
    expect(recorder.snapshot()).toBeUndefined();
    fixture.clock({ value: 150 });
    expect(run.finish({ status: 'partial', environment, operation })).toBe(true);
    const snapshot = recorder.snapshot()!;
    operation.result.text = 'later changed';
    operation.model.name = 'new model';
    expect(snapshot.operation.result.text).toBe('こんにちは。response');
    expect(snapshot.operation.model.name).toBe('model.gguf');
    expect(snapshot.elapsedMilliseconds).toMatchObject({ status: 'observed', value: 50 });
    expect(Object.isFrozen(snapshot.operation.model)).toBe(true);
    expect(run.record({ event: { kind: 'wasm_heap', capacityBytes: 42 } })).toBe(false);
    recorder.clear();
    expect(recorder.snapshot()).toBeUndefined();
    expect(snapshot.audio.output).toMatchObject({ status: 'retained', blob });
    const replacement = recorder.begin({ environment, operation });
    expect(replacement.id).not.toBe(run.id);
    expect(run.setAudio({ role: 'source', audio: { status: 'retained', blob, format: 'wav', description: 'late' } })).toBe(false);
    expect(run.finish({ status: 'failed', environment, operation })).toBe(false);
    replacement.finish({ status: 'completed', environment, operation });
    expect(recorder.snapshot()!.events).toEqual([]);
  });

  it('records event count and byte omissions without claiming complete telemetry', () => {
    const { run, recorder, environment, operation } = investigationFixture({ task: 'recognition' });
    for (let i = 0; i < speechInvestigationLimits.events + 2; i++) {
      run.record({ event: { kind: 'wasm_heap', capacityBytes: i } });
    }
    run.finish({ status: 'cancelled', environment, operation });
    const snapshot = recorder.snapshot()!;
    expect(snapshot.events).toHaveLength(512);
    expect(snapshot.events[511]?.sequence).toBe(511);
    expect(snapshot.capture.droppedEvents).toBe(2);
    expect(snapshot.capture.droppedEventBytes).toBeGreaterThan(0);
    expect(snapshot.audio.output.status).toBe('not_applicable');

    const next = recorder.begin({ environment, operation });
    const large = 'x'.repeat(speechInvestigationLimits.logTextBytes);
    expect(next.record({ event: { kind: 'native_log_batch', lines: Array.from({ length: 40 }, () => ({ level: 'info', text: large })), dropped: 3 } })).toBe(false);
    next.record({ event: { kind: 'cancel', state: 'settled', reason: 'user' } });
    next.finish({ status: 'cancelled', environment, operation });
    expect(recorder.snapshot()!.events[0]?.sequence).toBe(1);
    expect(recorder.snapshot()!.capture.droppedEvents).toBe(1);
    expect(recorder.snapshot()!.capture.eventBytes).toBeLessThan(speechInvestigationLimits.eventBytes);
  });

  it('bounds UTF-8 text without splitting Unicode and reports rejected terminal metadata', () => {
    const { run, recorder, environment, operation } = investigationFixture({ task: 'dialogue' });
    run.record({ event: { kind: 'native_log', level: 'error', message: 'あ'.repeat(10000) } });
    operation.result.text = 'あ'.repeat(100000);
    run.finish({ status: 'failed', environment, operation });
    const snapshot = recorder.snapshot()!;
    expect(new TextEncoder().encode(snapshot.operation.result.text).length).toBeLessThanOrEqual(speechInvestigationLimits.resultTextBytes);
    expect(snapshot.operation.result.text.endsWith('�')).toBe(false);
    expect(snapshot.events[0]?.truncatedCodeUnits).toBeGreaterThan(0);
    expect(snapshot.capture.truncatedCodeUnits).toBeGreaterThan(10000);

    const next = recorder.begin({ environment, operation });
    operation.model.info = observed({ value: { excessive: 'x'.repeat(speechInvestigationLimits.metadataBytes) } });
    next.finish({ status: 'failed', environment, operation });
    expect(recorder.snapshot()!.capture).toMatchObject({ rejectedMetadataUpdates: 1, latestMetadata: 'rejected' });
    expect(recorder.snapshot()!.operation.model.info).not.toEqual(operation.model.info);
    expect(() => recorder.begin({ environment, operation })).toThrow(/metadata exceeds/);
    expect(recorder.snapshot()).toBeUndefined();
  });

  it('reports unavailable clock observations and retains detailed errors', () => {
    const fixture = investigationFixture({ task: 'recognition' });
    fixture.clock({ value: 90 });
    const failure = { code: 'runtime_failed' as const, message: 'native detail', nativeStatus: 9, nativeInput: 'native request input detail' };
    fixture.run.record({ event: { kind: 'failure', stage: 'transcribe', failure } });
    failure.message = 'mutated';
    fixture.clock({ value: Number.NaN });
    fixture.run.finish({ status: 'failed', environment: fixture.environment, operation: fixture.operation });
    const snapshot = fixture.recorder.snapshot()!;
    expect(snapshot.capture.clockAnomalies).toBe(2);
    expect(snapshot.elapsedMilliseconds.status).toBe('unknown');
    expect(snapshot.events[0]).toMatchObject({ atMilliseconds: { status: 'unknown' }, event: { failure: { message: 'native detail', nativeStatus: 9, nativeInput: 'native request input detail' } } });
  });

  it('makes nonfinalizing checkpoints with current metadata, independent arrays/counters and Blob ownership', () => {
    const { run, recorder, environment, operation } = investigationFixture({ task: 'dialogue' });
    operation.source = { kind: 'unset', reason: 'Model load has no selected input yet' };
    run.record({ event: { kind: 'wasm_heap', capacityBytes: 100 } });
    const loading = run.checkpoint({ environment, operation })!;
    expect(loading).toMatchObject({ status: 'in_progress', finishedAt: undefined, capturedAt: '2026-11-16T00:00:00.000Z', operation: { source: { kind: 'unset' } } });
    expect(recorder.snapshot()).toBeUndefined();
    operation.source = { kind: 'recording', name: 'clip.wav', bytes: 50, mediaType: 'audio/wav', captureRequested: observed({ value: { echoCancellation: true } }), captureActual: observed({ value: { sampleRate: 48000 } }) };
    operation.result.text = 'Current partial response';
    const output = new Blob(['generated']);
    expect(run.setAudio({ role: 'output', audio: { status: 'retained', blob: output, format: 'wav', description: 'Partial output' } })).toBe(true);
    expect(run.record({ event: { kind: 'wasm_heap', capacityBytes: 200 } })).toBe(true);
    const active = run.checkpoint({ environment, operation })!;
    expect(active.operation.source).toMatchObject({ kind: 'recording', name: 'clip.wav' });
    expect(active.events).toHaveLength(2);
    expect(active.capture.audioBytes).toBe(output.size);
    expect(loading.events).toHaveLength(1);
    expect(loading.capture.audioBytes).toBe(0);
    expect(loading.operation.source.kind).toBe('unset');
    expect(run.finish({ status: 'completed', environment, operation })).toBe(true);
    expect(recorder.snapshot()).toMatchObject({ status: 'completed', finishedAt: '2026-11-16T00:00:00.000Z' });
    expect(active.status).toBe('in_progress');
    expect(run.checkpoint({ environment, operation })).toBeUndefined();
    recorder.clear();
    expect(active.audio.output).toMatchObject({ status: 'retained', blob: output });
  });

  it('counts retained metadata truncation once across checkpoints and final metadata replacement', () => {
    const { recorder, environment, operation } = investigationFixture({ task: 'dialogue' });
    operation.privateInputs.persona = 'あ'.repeat(30000);
    const run = recorder.begin({ environment, operation });
    const first = run.checkpoint({ environment, operation })!;
    const second = run.checkpoint({ environment, operation })!;
    expect(first.capture.truncatedCodeUnits).toBeGreaterThan(0);
    expect(second.capture.truncatedCodeUnits).toBe(first.capture.truncatedCodeUnits);
    operation.privateInputs.persona = 'short';
    run.finish({ status: 'completed', environment, operation });
    expect(recorder.snapshot()!.capture.truncatedCodeUnits).toBe(0);
    expect(first.capture.truncatedCodeUnits).toBeGreaterThan(0);
  });

  it('enforces the combined audio budget and releases replaced references', () => {
    const { run, recorder, environment, operation } = investigationFixture({ task: 'dialogue' });
    const unit = new Blob([new Uint8Array(1024 * 1024)]);
    const full = new Blob(Array.from({ length: 64 }, () => unit));
    expect(run.setAudio({ role: 'source', audio: { status: 'retained', blob: full, format: 'wav', description: 'source' } })).toBe(true);
    expect(run.setAudio({ role: 'output', audio: { status: 'retained', blob: unit, format: 'wav', description: 'output' } })).toBe(false);
    expect(run.setAudio({ role: 'source', audio: { status: 'unavailable', reason: 'Source cleared' } })).toBe(true);
    expect(run.setAudio({ role: 'output', audio: { status: 'retained', blob: unit, format: 'wav', description: 'output' } })).toBe(true);
    run.finish({ status: 'completed', environment, operation });
    expect(recorder.snapshot()!.capture.audioBytes).toBe(unit.size);
    expect(run.setAudio({ role: 'input', audio: { status: 'retained', blob: unit, format: 'wav', description: 'late' } })).toBe(false);
  });
});
