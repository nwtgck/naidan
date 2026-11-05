import { describe, it, expect, vi } from 'vitest';
import { audioFixture, audioResult } from './audio-generation.test-support';
import { readOutput } from './values';
import type { WorkflowOutput } from './output-store';
import { MAX_REFERENCE_BYTES } from '@/features/audio-generation/types';

async function bytes({ output }: { output: WorkflowOutput }): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of readOutput({ output, signal: undefined })) {
    chunks.push(chunk);
  }
  const result = new Uint8Array(output.byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function declaredReference({ size, bytes }: { size: number, bytes: Uint8Array }) {
  const openStream = vi.fn(() => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }));
  const output: WorkflowOutput = { byteLength: size, openStream, retain: () => output, release: async () => undefined };
  return { reference: { type: 'binary' as const, output }, openStream };
}

describe('Workflow audio effect boundary', () => {
  it('spools valid native audio and exposes format, actual metadata and completion', async () => {
    await using test = audioFixture();
    const outputs = await test.execute({ overrides: {} });
    expect(test.generate).toHaveBeenCalledExactlyOnceWith({ input: { ...test.input.request, reference: undefined, debug: 'off' }, cancellationSignal: test.controller.signal });
    expect(test.normalize).not.toHaveBeenCalled();
    expect(outputs.audio?.type).toBe('binary');
    if (outputs.audio?.type !== 'binary') {
      throw new Error('Missing audio');
    }
    expect(outputs.audio.format).toBe('wav');
    expect(await bytes({ output: outputs.audio.output })).toEqual(test.result.wav);
    expect(outputs.complete).toEqual({ type: 'json', value: true });
    expect(outputs.metadata).toEqual({ type: 'json', value: { sampleRate: 24000, samples: 4, frames: 1, finishReason: 'stop', pipeline: 'qwen3-tts', byteLength: 52 } });
  });

  it('writes bounded chunks instead of base64 or a single oversized write', async () => {
    await using test = audioFixture();
    const result = audioResult({ samples: 60000, finishReason: 'stop' });
    test.generate.mockResolvedValue(result);
    const outputs = await test.execute({ overrides: {} });
    if (outputs.audio?.type !== 'binary') {
      throw new Error('Missing audio');
    }
    expect(await bytes({ output: outputs.audio.output })).toEqual(result.wav);
    expect(test.store.getUsage().bytes).toBe(result.wav.byteLength);
    expect(test.calls.filter(call => call === 'write')).toHaveLength(4);
  });

  it.each(['frame-limit', 'context-limit'] as const)('rejects %s by default without output allocation', async finishReason => {
    await using test = audioFixture();
    test.generate.mockResolvedValue(audioResult({ samples: 4, finishReason }));
    await expect(test.execute({ overrides: {} })).rejects.toThrow(finishReason);
    expect(test.store.getUsage().entries).toBe(0);
  });

  it.each(['frame-limit', 'context-limit'] as const)('keeps %s only with explicit incomplete output policy', async finishReason => {
    await using test = audioFixture();
    test.generate.mockResolvedValue(audioResult({ samples: 4, finishReason }));
    const outputs = await test.execute({ overrides: { onLimit: 'keep' } });
    expect(outputs.complete).toEqual({ type: 'json', value: false });
    expect(outputs.metadata).toMatchObject({ value: { finishReason } });
  });

  it('does not mistake a native user-stop for a completed or intentionally limited result', async () => {
    await using test = audioFixture();
    test.generate.mockResolvedValue(audioResult({ samples: 4, finishReason: 'user-stop' }));
    await expect(test.execute({ overrides: { onLimit: 'keep' } })).rejects.toThrow('stopped');
    expect(test.store.getUsage().entries).toBe(0);
  });

  it('does not normalize or generate when already cancelled', async () => {
    await using test = audioFixture();
    test.controller.abort(new Error('Stopped'));
    await expect(test.execute({ overrides: {} })).rejects.toThrow('Stopped');
    expect(test.generate).not.toHaveBeenCalled();
    expect(test.normalize).not.toHaveBeenCalled();
  });

  it('awaits active generation settlement after stop and discards late successful audio', async () => {
    await using test = audioFixture();
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>();
    test.generate.mockReturnValue(gate.promise);
    const settled = vi.fn();
    const pending = test.execute({ overrides: {} });
    const handled = pending.then(settled, settled);
    await vi.waitFor(() => expect(test.generate).toHaveBeenCalledOnce());
    test.controller.abort(new Error('Stopped'));
    // Drain cancellation microtasks before checking ownership; a single await
    // can miss an incorrectly raced engine promise.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    gate.resolve(test.result);
    await expect(pending).rejects.toThrow('Stopped');
    await handled;
    expect(test.store.getUsage().entries).toBe(0);
  });

  it('validates the request before calling the engine', async () => {
    await using test = audioFixture();
    await expect(test.execute({ overrides: { request: { ...test.input.request, maxFrames: 0 } } })).rejects.toThrow();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it.each(['container', 'samples', 'rate', 'frames'] as const)('rejects inconsistent %s before publishing', async field => {
    await using test = audioFixture();
    const result = audioResult({ samples: 4, finishReason: 'stop' });
    switch (field) {
    case 'container': result.wav[0] = 0;
      break;
    case 'samples': result.samples++;
      break;
    case 'rate': result.sampleRate++;
      break;
    case 'frames': result.frames = 2049;
      break;
    default: {
      const exhaustive: never = field;
      throw new Error(String(exhaustive));
    }
    }
    test.generate.mockResolvedValue(result);
    await expect(test.execute({ overrides: {} })).rejects.toThrow();
    expect(test.store.getUsage().entries).toBe(0);
  });

  it.each(['write', 'close'] as const)('cleans temporary output after a %s failure', async operation => {
    await using test = audioFixture();
    test.failNext({ operation, error: new Error('storage failure') });
    await expect(test.execute({ overrides: {} })).rejects.toThrow('storage failure');
    expect(test.store.getUsage().entries).toBe(0);
    expect(test.files.size).toBe(0);
  });

  it('cleans a partially written output when stopping during a storage write', async () => {
    await using test = audioFixture();
    const gate = test.pauseNext({ operation: 'write' });
    const pending = test.execute({ overrides: {} });
    const rejected = expect(pending).rejects.toThrow();
    await gate.entered;
    test.controller.abort(new Error('Stopped'));
    gate.release();
    await rejected;
    expect(test.store.getUsage().entries).toBe(0);
  });

  it.each([0, MAX_REFERENCE_BYTES + 1])('rejects reference size %i before opening its stream', async size => {
    await using test = audioFixture();
    const source = declaredReference({ size, bytes: new Uint8Array(1) });
    await expect(test.execute({ overrides: { reference: source.reference } })).rejects.toThrow('16 MiB');
    expect(source.openStream).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it.each([3, 5])('rejects reference byte counts inconsistent with declared size %i', async size => {
    await using test = audioFixture();
    const source = declaredReference({ size, bytes: new Uint8Array(4) });
    await expect(test.execute({ overrides: { reference: source.reference } })).rejects.toThrow();
    expect(test.normalize).not.toHaveBeenCalled();
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('normalizes a referenced file with explicit duration rejection and passes only that voice', async () => {
    await using test = audioFixture();
    const source = declaredReference({ size: 4, bytes: Uint8Array.of(1, 2, 3, 4) });
    await test.execute({ overrides: { reference: source.reference } });
    const normalization = test.normalize.mock.calls[0]![0];
    expect(normalization.durationPolicy).toBe('reject');
    expect(normalization.signal).toBe(test.controller.signal);
    expect(new Uint8Array(await normalization.source.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(test.generate.mock.calls[0]![0].input.reference).toBe(normalization.source);
  });

  it('does not silently drop an undecodable or overlong reference', async () => {
    await using test = audioFixture();
    const source = declaredReference({ size: 4, bytes: new Uint8Array(4) });
    test.normalize.mockRejectedValue(new Error('Reference is too long'));
    await expect(test.execute({ overrides: { reference: source.reference } })).rejects.toThrow('too long');
    expect(test.generate).not.toHaveBeenCalled();
  });

  it('does not start generation after reference preparation finishes late', async () => {
    await using test = audioFixture();
    const source = declaredReference({ size: 4, bytes: new Uint8Array(4) });
    test.normalize.mockImplementation(async ({ source }) => {
      test.controller.abort(new Error('Stopped'));
      return { wav: source, samples: 4, trimmed: false };
    });
    await expect(test.execute({ overrides: { reference: source.reference } })).rejects.toThrow('Stopped');
    expect(test.generate).not.toHaveBeenCalled();
  });
});
