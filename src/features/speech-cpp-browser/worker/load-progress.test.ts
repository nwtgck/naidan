// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createSpeechLoadReporter, createSpeechReadCoverage, readSpeechWasm, createSpeechLoadObservation } from './load-progress';
import type { SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import type { SpeechInvestigationEvent } from '@/features/speech-cpp-browser/investigation/types';

describe('speech load progress reports measured work', () => {
  it('records real stage intervals separately from byte counts and never clocks an ordinary load', () => {
    const now = vi.fn(() => 0);
    expect(createSpeechLoadObservation({ observer: undefined, now })).toBeUndefined();
    expect(now).not.toHaveBeenCalled();
    const events: SpeechInvestigationEvent[] = [];
    let time = 0;
    const observation = createSpeechLoadObservation({ observer: ({ event }) => events.push(event), now: () => time })!;
    observation.progress({ progress: { stage: 'checking_model' } });
    time = 120;
    observation.progress({ progress: { stage: 'reading_model', readBytes: 10, totalBytes: 100 } });
    time = 500;
    observation.progress({ progress: { stage: 'checking_loaded_model' } });
    observation.finish({ state: 'completed' });
    expect(events).toContainEqual({ kind: 'stage', stage: 'checking_model', state: 'completed', durationMilliseconds: 120, heapBytes: undefined, details: undefined });
    expect(events).toContainEqual({ kind: 'progress', stage: 'reading_model', value: 10, total: 100, unit: 'bytes', provenance: 'observed', details: undefined });
    expect(events).toContainEqual({ kind: 'stage', stage: 'load_ready', state: 'completed', durationMilliseconds: undefined, heapBytes: undefined, details: undefined });
  });

  it('counts the union of disjoint and overlapping reads, including offsets above 4 GiB', () => {
    const base = 2 ** 32;
    const coverage = createSpeechReadCoverage({ size: base + 100 });
    expect(coverage.add({ offset: base + 40, length: 24 })).toBe(24);
    expect(coverage.add({ offset: base + 45, length: 5 })).toBe(24);
    expect(coverage.add({ offset: base + 10, length: 10 })).toBe(34);
    expect(coverage.add({ offset: base + 20, length: 20 })).toBe(54);
    expect(coverage.add({ offset: 0, length: 8 })).toBe(62);
    expect(coverage.add({ offset: base + 100, length: 0 })).toBe(62);
    expect(() => coverage.add({ offset: base + 99, length: 2 })).toThrow();
  });

  it('throttles small read updates and immediately publishes stage transitions', () => {
    let time = 0;
    const values: SpeechLoadProgress[] = [];
    const report = createSpeechLoadReporter({ onProgress: ({ progress }) => values.push(progress), now: () => time });
    report({ progress: { stage: 'preparing_model' } });
    report({ progress: { stage: 'reading_model', readBytes: 0, totalBytes: 10000 } });
    time = 10;
    report({ progress: { stage: 'reading_model', readBytes: 50, totalBytes: 10000 } });
    expect(values).toHaveLength(2);
    time = 20;
    report({ progress: { stage: 'reading_model', readBytes: 100, totalBytes: 10000 } });
    expect(values).toHaveLength(3);
    time = 121;
    report({ progress: { stage: 'reading_model', readBytes: 101, totalBytes: 10000 } });
    report({ progress: { stage: 'preparing_model' } });
    expect(values).toHaveLength(5);
    expect(values.at(-1)).toEqual({ stage: 'preparing_model' });
  });

  it('counts actual compressed chunks and decompressed bytes without trusting content length', async () => {
    const bytes = Uint8Array.from({ length: 40000 }, (_, index) => index % 251);
    const compressed = Uint8Array.from(gzipSync(bytes));
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(compressed.slice(0, 16));
        controller.enqueue(compressed.slice(16));
        controller.close();
      },
    });
    const values: SpeechLoadProgress[] = [];
    const actual = await readSpeechWasm({ response: new Response(body, { headers: { 'content-length': '1' } }), wasmBytes: bytes.length, onProgress: ({ progress }) => values.push(progress) });
    expect(actual).toEqual(bytes);
    expect(values.at(-1)).toEqual({ stage: 'loading_runtime', fetchedBytes: compressed.length, decompressedBytes: bytes.length, totalDecompressedBytes: bytes.length });
    expect(values).toContainEqual({ stage: 'loading_runtime', fetchedBytes: 16, decompressedBytes: 0, totalDecompressedBytes: bytes.length });
  });

  it.each([1, 3])('rejects a decompressed size different from the manifest size %s', async wasmBytes => {
    const compressed = Uint8Array.from(gzipSync(new Uint8Array([1, 2])));
    await expect(readSpeechWasm({ response: new Response(compressed), wasmBytes, onProgress() {} })).rejects.toThrow();
  });
});
