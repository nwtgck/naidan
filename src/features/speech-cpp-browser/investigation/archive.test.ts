// @vitest-environment node
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { createSpeechInvestigationArchive, downloadSpeechInvestigation } from './archive';
import { collectionFromSnapshot, investigationFixture, observed, waveBytes } from './investigation.test-support';
import type { SpeechInvestigationSnapshot } from './types';
import { speechInvestigationCollectionLimits, speechInvestigationLimits } from './types';

const trialPrefix = 'trials/001-trial-1/';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/utils/stream-download', () => ({ downloadReadableStream: download }));

async function collectArchive({ snapshot, includeInputAudio, includeInputText }: { snapshot: SpeechInvestigationSnapshot, includeInputAudio: 'on' | 'off', includeInputText: 'on' | 'off' }) {
  const archive = createSpeechInvestigationArchive({ collection: collectionFromSnapshot({ snapshot }), includeInputAudio, includeInputText, signal: new AbortController().signal });
  const bytes = await new Response(archive.stream).arrayBuffer();
  expect(bytes.byteLength).toBeLessThanOrEqual(speechInvestigationCollectionLimits.zipBytes);
  return { archive, zip: await JSZip.loadAsync(bytes) };
}

function terminalFixture({ task }: { task: 'dialogue' | 'recognition' }) {
  const fixture = investigationFixture({ task });
  const wav = new Blob([waveBytes()], { type: 'audio/wav' });
  fixture.run.setAudio({ role: 'source', audio: { status: 'retained', blob: wav, format: 'wav', description: 'Original selected WAV' } });
  fixture.run.setAudio({ role: 'input', audio: { status: 'retained', blob: wav, format: 'wav', description: 'Exact input PCM WAV before Worker transfer' } });
  if (task === 'dialogue') {
    fixture.run.setAudio({ role: 'output', audio: { status: 'retained', blob: wav, format: 'wav', description: 'Generated PCM before playback' } });
  }
  fixture.run.record({ event: { kind: 'native_log_batch', lines: [{ level: 'error', text: 'Detailed model diagnostic, retained verbatim' }], dropped: 2 } });
  fixture.run.record({ event: { kind: 'model_info', rawJson: '{"defaults":{"threads":4},"options":{"language":"ja"},"source":"native"}', device: observed({ value: 'actual device' }), threads: observed({ value: 4 }), weightType: observed({ value: 'Q8_0' }), weightBytes: observed({ value: '8589934592' }) } });
  fixture.run.finish({ status: 'partial', environment: fixture.environment, operation: fixture.operation });
  return { ...fixture, snapshot: fixture.recorder.snapshot()!, wav };
}

describe('speech investigation ZIP', () => {
  it.each(['dialogue', 'recognition'] as const)('includes useful %s text/identity/settings/errors/logs/measurements by default, without input bodies/audio', async task => {
    const { snapshot, recorder } = terminalFixture({ task });
    const { zip, archive } = await collectArchive({ snapshot, includeInputAudio: 'off', includeInputText: 'off' });
    recorder.clear();
    const operationText = await zip.file(trialPrefix + 'operation.json')!.async('string');
    const operation = JSON.parse(operationText);
    expect(operation.result.text).toBe(task === 'dialogue' ? 'こんにちは。response' : '認識した文章');
    expect(operation.source.name).toBe('../../こんにちは.wav');
    expect(operation.model).toMatchObject({ name: 'model.gguf', id: { status: 'observed', value: 'selected-model' } });
    expect(operation.requested.seed).toMatchObject({ status: 'observed', value: 0 });
    expect(operation.effective.language.value).toBe('ja');
    expect(operation.failure.value).toMatchObject({ nativeStatus: 7, nativeInput: 'dialogue_end: internal detail', message: 'Detailed native failure' });
    expect(operation.measurements.generation).toMatchObject({ value: { value: 1234 }, unit: 'milliseconds' });
    expect(operation.privateInputs).toEqual({ persona: 'set', instructions: 'set', name: 'set' });
    expect(operationText).not.toContain('private persona');
    expect(operationText).not.toContain('private instructions');
    expect(zip.file(trialPrefix + 'input.json')).toBeNull();
    expect(zip.file('source/audio.wav')).toBeNull();
    expect(zip.file(trialPrefix + 'audio/input.wav')).toBeNull();
    expect(zip.file(trialPrefix + 'audio/output.wav') !== null).toBe(task === 'dialogue');
    const events = (await zip.file(trialPrefix + 'events.jsonl')!.async('string')).trim().split('\n').map(line => JSON.parse(line));
    expect(events[0].event).toMatchObject({ kind: 'native_log_batch', dropped: 2, lines: [{ text: 'Detailed model diagnostic, retained verbatim' }] });
    expect(events[1].event.rawJson).toContain('"defaults":{"threads":4}');
    expect(events[1].event.weightBytes.value).toBe('8589934592');
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest).toMatchObject({ version: 2, collection: { status: 'partial' }, selection: { includeInputAudio: 'off', includeInputText: 'off' } });
    expect(manifest.trials[0]).toMatchObject({ status: 'partial', record: { capture: { latestMetadata: 'accepted' } } });
    expect(JSON.parse(await zip.file('plan.json')!.async('string')).task).toBe(task);
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: 'source/audio.wav', status: 'omitted', reason: expect.stringContaining('not selected') }));
    expect(manifest.sourceAudio).toEqual({ status: 'retained', bytes: 50, format: 'wav', description: 'Original selected WAV' });
    expect(manifest.trials[0].record.audio.input).toEqual({ status: 'retained', bytes: 50, format: 'wav', description: 'Exact input PCM WAV before Worker transfer' });
    expect(Object.keys(zip.files).every(name => !name.includes('..') && !name.includes('こんにちは'))).toBe(true);
    expect(archive.filename).toMatch(/^naidan-speech-investigation-[a-zA-Z0-9_-]+\.zip$/);
    const environment = JSON.parse(await zip.file(trialPrefix + 'environment.json')!.async('string'));
    expect(environment.gpuDevice).toMatchObject({ status: 'unavailable', reason: 'No actual adapter observation hook' });
    expect(environment.runtime.value).toMatchObject({ wasmVerification: 'verified', sourceCommit: 'runtime-commit', profile: 'webgpu-wasm64-jspi' });
    const readme = await zip.file('README.md')!.async('string');
    expect(readme).toContain('not pure inference');
    expect(readme).toContain('not proven disk storage');
  });

  it('includes opted-in exact original/submitted WAV bytes and instruction bodies without reading Blob.arrayBuffer', async () => {
    const { snapshot, wav, recorder } = terminalFixture({ task: 'dialogue' });
    const fullRead = vi.spyOn(wav, 'arrayBuffer').mockRejectedValue(new Error('No full source copy allowed'));
    const { stream } = createSpeechInvestigationArchive({ collection: collectionFromSnapshot({ snapshot }), includeInputAudio: 'on', includeInputText: 'on', signal: new AbortController().signal });
    recorder.clear();
    const bytes = await new Response(stream).arrayBuffer();
    expect(fullRead).not.toHaveBeenCalled();
    const zip = await JSZip.loadAsync(bytes);
    for (const name of ['source/audio.wav', trialPrefix + 'audio/input.wav', trialPrefix + 'audio/output.wav']) {
      const data = await zip.file(name)!.async('uint8array');
      expect(data).toEqual(waveBytes());
      expect(new DataView(data.buffer, data.byteOffset).getUint32(24, true)).toBe(24000);
      expect(new DataView(data.buffer, data.byteOffset).getUint16(34, true)).toBe(16);
    }
    expect(JSON.parse(await zip.file(trialPrefix + 'input.json')!.async('string'))).toEqual({ persona: 'private persona', instructions: 'private instructions', name: 'private character' });
    fullRead.mockRestore();
  });

  it.each(['on', 'off'] as const)('explains original missing-audio reasons with audio export %s and rejected metadata', async includeInputAudio => {
    const { run, recorder, environment, operation } = investigationFixture({ task: 'recognition' });
    run.setAudio({ role: 'source', audio: { status: 'unavailable', reason: 'Recording was cleared before retention' } });
    operation.model.info = observed({ value: { tooLarge: 'x'.repeat(speechInvestigationLimits.metadataBytes) } });
    run.finish({ status: 'failed', environment, operation });
    const { zip } = await collectArchive({ snapshot: recorder.snapshot()!, includeInputAudio, includeInputText: 'off' });
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.trials[0].record.capture).toMatchObject({ rejectedMetadataUpdates: 1, latestMetadata: 'rejected' });
    expect(manifest.files).toContainEqual({ path: 'source/audio.bin', status: 'omitted', reason: includeInputAudio === 'on' ? 'Recording was cleared before retention' : 'Input audio was not selected at export' });
    expect(manifest.sourceAudio).toEqual({ status: 'unavailable', reason: 'Recording was cleared before retention' });
    expect(manifest.trials[0].record.audio.input).toEqual({ status: 'unavailable', reason: 'Submitted PCM was not retained' });
    expect(manifest.trials[0].record.audio.output).toEqual({ status: 'not_applicable', reason: 'Recognition produces text' });
    expect(zip.file('source/audio.bin')).toBeNull();
    expect(zip.file(trialPrefix + 'audio/input.wav')).toBeNull();
    expect(manifest.files).toContainEqual({ path: trialPrefix + 'audio/output.wav', status: 'omitted', reason: 'Recognition produces text' });
    expect(manifest.trials[0].status).toBe('failed');
  });

  it.each(['signal', 'consumer'] as const)('cancels the active Blob reader on %s cancellation', async mode => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    class PendingBlob extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream({
          start() {
            started.resolve();
          },
          cancel() {
            cancelled.resolve();
          },
        });
      }
    }
    const { run, recorder, environment, operation } = investigationFixture({ task: 'dialogue' });
    run.setAudio({ role: 'output', audio: { status: 'retained', blob: new PendingBlob(['x']), format: 'wav', description: 'Pending source stream' } });
    run.finish({ status: 'completed', environment, operation });
    const abort = new AbortController();
    const { stream } = createSpeechInvestigationArchive({ collection: collectionFromSnapshot({ snapshot: recorder.snapshot()! }), includeInputAudio: 'off', includeInputText: 'off', signal: abort.signal });
    await started.promise;
    if (mode === 'signal') {
      abort.abort(new Error('Stopped export'));
      await expect(new Response(stream).arrayBuffer()).rejects.toThrow('Stopped export');
    } else {
      await stream.cancel();
    }
    await cancelled.promise;
  });

  it('fails mismatched Blob sizes and over-budget snapshots rather than exporting silent truncation', async () => {
    class IncorrectBlob extends Blob {
      override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new Blob(['more bytes than declared']).stream();
      }
    }
    const { run, recorder, environment, operation } = investigationFixture({ task: 'dialogue' });
    run.setAudio({ role: 'output', audio: { status: 'retained', blob: new IncorrectBlob(['x']), format: 'wav', description: 'Invalid producer' } });
    run.finish({ status: 'completed', environment, operation });
    const snapshot = recorder.snapshot()!;
    const { stream } = createSpeechInvestigationArchive({ collection: collectionFromSnapshot({ snapshot }), includeInputAudio: 'off', includeInputText: 'off', signal: new AbortController().signal });
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow(/byte length/);
    const oversized = { ...snapshot, capture: { ...snapshot.capture, metadataBytes: speechInvestigationLimits.metadataBytes + 1 } };
    expect(() => createSpeechInvestigationArchive({ collection: collectionFromSnapshot({ snapshot: oversized }), includeInputAudio: 'off', includeInputText: 'off', signal: new AbortController().signal })).toThrow(/metadata\/event limits/);
  });

  it('exports an in-progress checkpoint without finalizing or pretending model input already exists', async () => {
    const { run, recorder, environment, operation } = investigationFixture({ task: 'recognition' });
    operation.source = { kind: 'unset', reason: 'No audio selected during model load' };
    run.record({ event: { kind: 'progress', stage: 'reading_model', value: 50, total: 100, unit: 'bytes', provenance: 'observed', details: undefined } });
    const checkpoint = run.checkpoint({ environment, operation })!;
    const { zip } = await collectArchive({ snapshot: checkpoint, includeInputAudio: 'off', includeInputText: 'off' });
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.load).toMatchObject({ status: 'in_progress', capturedAt: '2026-11-16T00:00:00.000Z' });
    expect(manifest.load.finishedAt).toBeUndefined();
    expect(JSON.parse(await zip.file('load/operation.json')!.async('string')).source).toEqual({ kind: 'unset', reason: 'No audio selected during model load' });
    expect(run.record({ event: { kind: 'wasm_heap', capacityBytes: 1024 } })).toBe(true);
    expect(run.finish({ status: 'failed', environment, operation })).toBe(true);
    expect(checkpoint.events).toHaveLength(1);
    expect(recorder.snapshot()!.events).toHaveLength(2);
  });

  it('passes a cancellable stream without a declared ZIP length to the existing download boundary', async () => {
    const { snapshot } = terminalFixture({ task: 'recognition' });
    download.mockImplementationOnce(async ({ stream, size, filename }: { stream: ReadableStream<Uint8Array>, size: number | undefined, filename: string }) => {
      expect(size).toBeUndefined();
      expect((await new Response(stream).arrayBuffer()).byteLength).toBeLessThanOrEqual(speechInvestigationCollectionLimits.zipBytes);
      expect(filename).toMatch(/^naidan-speech-investigation-/);
    });
    const signal = new AbortController().signal;
    await downloadSpeechInvestigation({ collection: collectionFromSnapshot({ snapshot }), includeInputAudio: 'off', includeInputText: 'off', signal });
    expect(download).toHaveBeenLastCalledWith(expect.objectContaining({ signal, size: undefined, stream: expect.any(ReadableStream) }));
  });
});
