import { describe, expect, it } from 'vitest';
import { createWorkflowOutputStore, type WorkflowOutputLimits } from './output-store';
import { createOutputStoreFixture } from './output-store.test-support';

async function readBytes({ stream }: { stream: ReadableStream<Uint8Array> }): Promise<number[]> {
  const reader = stream.getReader();
  await using resource = {
    async [Symbol.asyncDispose]() {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    },
  };
  void resource;
  const bytes: number[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return bytes;
    }
    bytes.push(...next.value);
  }
}

const noSignal = { signal: undefined };
const bytes = new Uint8Array([1, 2, 3, 4]);

describe('Workflow output ownership and replay', () => {
  it('publishes only after close and independently replays one production twice', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    expect([...fixture.files.values()][0]?.length).toBe(0);
    const output = await writer.seal();
    expect(output.byteLength).toBe(4);
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([1, 2, 3, 4]);
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([1, 2, 3, 4]);
    expect(fixture.calls.filter(call => call === 'write')).toHaveLength(1);
    await output.release();
    expect(fixture.store.getUsage()).toEqual({ entries: 0, bytes: 0, pendingWriteBytes: 0, readers: 0 });
  });

  it('keeps completed output readable after production is cancelled', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const controller = new AbortController();
    const writer = await fixture.store.createWriter({ signal: controller.signal });
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    controller.abort(new Error('Stop later steps'));
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([...bytes]);
  });

  it('retains a shared output until the last independent lease releases it', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const first = await writer.seal();
    const second = first.retain();
    await first.release();
    await first.release();
    expect(() => first.retain()).toThrow(/released/);
    expect(() => first.openStream(noSignal)).toThrow(/released/);
    expect(await readBytes({ stream: second.openStream(noSignal) })).toEqual([...bytes]);
    expect(fixture.files.size).toBe(1);
    await second.release();
    expect(fixture.files.size).toBe(0);
  });

  it('a reader keeps storage alive even when its parent lease is released', async () => {
    await using fixture = createOutputStoreFixture({ limits: { readChunkBytes: 2 } });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    const stream = output.openStream(noSignal);
    await output.release();
    expect(fixture.files.size).toBe(1);
    expect(await readBytes({ stream })).toEqual([...bytes]);
    expect(fixture.files.size).toBe(0);
  });

  it('does not read or buffer a dormant fan-out consumer', async () => {
    await using fixture = createOutputStoreFixture({ limits: { readChunkBytes: 2 } });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    const dormant = output.openStream(noSignal);
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([...bytes]);
    expect(fixture.calls.filter(call => call === 'read')).toHaveLength(2);
    expect(fixture.store.getUsage().readers).toBe(1);
    expect(await readBytes({ stream: dormant })).toEqual([...bytes]);
  });

  it('cancels one reader without affecting another', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    const controller = new AbortController();
    const first = output.openStream({ signal: controller.signal });
    const second = output.openStream(noSignal);
    controller.abort(new Error('Only this preview'));
    await expect(readBytes({ stream: first })).rejects.toThrow('Only this preview');
    expect(await readBytes({ stream: second })).toEqual([...bytes]);
  });

  it('snapshots accepted input before asynchronous writes can reuse the buffer', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    const pause = fixture.pauseNext({ operation: 'write' });
    const backing = new Uint8Array(1024);
    backing.set(bytes, 10);
    const write = writer.write({ chunk: backing.subarray(10, 14) });
    backing.fill(99);
    await pause.entered;
    pause.release();
    await write;
    const output = await writer.seal();
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([...bytes]);
  });

  it('supports a zero-byte sealed result', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    const output = await writer.seal();
    expect(output.byteLength).toBe(0);
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([]);
    await output.release();
  });

  it('does not allow production methods to mutate a sealed result', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    const output = await writer.seal();
    await expect(writer.write({ chunk: bytes })).rejects.toThrow();
    await expect(writer.seal()).rejects.toThrow();
    await expect(writer.abort({ reason: new Error('abort') })).rejects.toThrow(/leases/);
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([]);
  });
});

describe('Workflow output limits', () => {
  it.each(['maxEntries', 'maxBytes', 'maxOutputBytes', 'maxPendingWriteBytes', 'maxWriteChunkBytes', 'readChunkBytes', 'maxReaders'] as const)('validates %s without opening files', async key => {
    const limits: WorkflowOutputLimits = { maxEntries: 1, maxBytes: 100, maxOutputBytes: 100, maxPendingWriteBytes: 4, maxWriteChunkBytes: 4, readChunkBytes: 4, maxReaders: 1 };
    expect(() => createWorkflowOutputStore({ directory: {} as FileSystemDirectoryHandle, limits: { ...limits, [key]: 0 } })).toThrow(/positive safe integers/);
  });

  it('counts opening writers against the entry budget', async () => {
    await using fixture = createOutputStoreFixture({ limits: { maxEntries: 1 } });
    const pause = fixture.pauseNext({ operation: 'open' });
    const first = fixture.store.createWriter(noSignal);
    await pause.entered;
    await expect(fixture.store.createWriter(noSignal)).rejects.toThrow(/count limit/);
    pause.release();
    await first;
  });

  it('reserves capacity across in-flight writers and never seals a rejected prefix', async () => {
    await using fixture = createOutputStoreFixture({ limits: { maxBytes: 6 } });
    const first = await fixture.store.createWriter(noSignal);
    const second = await fixture.store.createWriter(noSignal);
    const pause = fixture.pauseNext({ operation: 'write' });
    const write = first.write({ chunk: bytes });
    await pause.entered;
    await expect(second.write({ chunk: bytes })).rejects.toThrow(/byte limit/);
    await expect(second.seal()).rejects.toThrow();
    pause.release();
    await write;
    const output = await first.seal();
    expect(output.byteLength).toBe(4);
    await output.release();
  });

  it('bounds total pending writes across outputs', async () => {
    await using fixture = createOutputStoreFixture({ limits: { maxPendingWriteBytes: 4 } });
    const first = await fixture.store.createWriter(noSignal);
    const second = await fixture.store.createWriter(noSignal);
    const pause = fixture.pauseNext({ operation: 'write' });
    const write = first.write({ chunk: bytes });
    await pause.entered;
    expect(fixture.store.getUsage().pendingWriteBytes).toBe(4);
    await expect(second.write({ chunk: bytes })).rejects.toThrow(/Pending write/);
    pause.release();
    await write;
    expect(fixture.store.getUsage().pendingWriteBytes).toBe(0);
  });

  it('rejects concurrent writes instead of queueing unbounded promises or silently dropping chunks', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    const pause = fixture.pauseNext({ operation: 'write' });
    const first = writer.write({ chunk: bytes }).then(() => 'success', () => 'failed');
    await pause.entered;
    await expect(writer.write({ chunk: bytes })).rejects.toThrow(/busy/);
    pause.release();
    expect(await first).toBe('failed');
    await expect(writer.seal()).rejects.toThrow();
  });

  it.each([{ maxWriteChunkBytes: 3 }, { maxOutputBytes: 3 }])('does not publish output after a rejected chunk: %j', async limits => {
    await using fixture = createOutputStoreFixture({ limits });
    const writer = await fixture.store.createWriter(noSignal);
    await expect(writer.write({ chunk: bytes })).rejects.toThrow(/limit/);
    await expect(writer.seal()).rejects.toThrow();
  });

  it('enforces a reader budget, including streams not yet pulled', async () => {
    await using fixture = createOutputStoreFixture({ limits: { maxReaders: 1 } });
    const writer = await fixture.store.createWriter(noSignal);
    const output = await writer.seal();
    const stream = output.openStream(noSignal);
    expect(() => output.openStream(noSignal)).toThrow(/Reader limit/);
    await stream.cancel();
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([]);
  });
});

describe('Workflow output cancellation, faults and cleanup', () => {
  it('allocates nothing for an already cancelled producer', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    await expect(fixture.store.createWriter({ signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fixture.calls).toEqual([]);
  });

  it.each(['open', 'write', 'close', 'snapshot'] as const)('does not publish cancellation during %s as success', async operation => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const controller = new AbortController();
    const pause = fixture.pauseNext({ operation });
    const production = (async () => {
      const writer = await fixture.store.createWriter({ signal: controller.signal });
      await writer.write({ chunk: bytes });
      return writer.seal();
    })().then(() => 'success', () => 'failed');
    await pause.entered;
    controller.abort(new Error('stopped'));
    pause.release();
    expect(await production).toBe('failed');
    await fixture.store.close();
    expect(fixture.files.size).toBe(0);
    expect(fixture.store.getUsage().bytes).toBe(0);
  });

  it.each(['open', 'write', 'close', 'snapshot'] as const)('preserves the original %s failure and removes temporary files', async operation => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const error = new Error(`fault at ${operation}`);
    fixture.failNext({ operation, error });
    await expect((async () => {
      const writer = await fixture.store.createWriter(noSignal);
      await writer.write({ chunk: bytes });
      await writer.seal();
    })()).rejects.toBe(error);
    await fixture.store.close();
    expect(fixture.files.size).toBe(0);
  });

  it('does not free an output while its last reader has pending native I/O', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    const pause = fixture.pauseNext({ operation: 'read' });
    const controller = new AbortController();
    const reader = output.openStream({ signal: controller.signal }).getReader();
    const reading = reader.read().then(() => 'success', () => 'cancelled');
    await pause.entered;
    await output.release();
    controller.abort(new Error('read cancelled'));
    expect(await reading).toBe('cancelled');
    expect(fixture.files.size).toBe(1);
    pause.release();
    await fixture.store.close();
    expect(fixture.files.size).toBe(0);
    reader.releaseLock();
  });

  it('revokes other readers immediately while closing waits for an unrelated native write', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const completed = await fixture.store.createWriter(noSignal);
    const result = await completed.seal();
    const writing = await fixture.store.createWriter(noSignal);
    const pause = fixture.pauseNext({ operation: 'write' });
    const pending = writing.write({ chunk: bytes }).then(() => 'success', () => 'stopped');
    await pause.entered;
    const reader = result.openStream(noSignal).getReader();
    const closing = fixture.store.close();
    await expect(reader.read()).rejects.toThrow(/closed/);
    expect(() => result.retain()).toThrow(/closed/);
    pause.release();
    await pending;
    await closing;
    reader.releaseLock();
  });

  it('reports truncated reads instead of returning a successful partial result', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const result = await writer.seal();
    fixture.adjustRead({ bytes: -1 });
    await expect(readBytes({ stream: result.openStream(noSignal) })).rejects.toThrow(/truncated/);
    expect(fixture.store.getUsage().readers).toBe(0);
  });

  it('retains storage accounting on failed deletion and permits cleanup retry', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const result = await writer.seal();
    fixture.failNext({ operation: 'remove', error: new Error('disk unavailable') });
    await expect(result.release()).rejects.toThrow('disk unavailable');
    expect(fixture.store.getUsage().bytes).toBe(4);
    fixture.failNext({ operation: 'remove', error: new Error('still unavailable') });
    await expect(fixture.store.close()).rejects.toThrow(/Failed to remove/);
    await expect(fixture.store.createWriter(noSignal)).rejects.toThrow(/closed/);
    await fixture.store.close();
    expect(fixture.store.getUsage().bytes).toBe(0);
  });

  it('closes idempotently and rejects later writes', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const first = fixture.store.close();
    expect(fixture.store.close()).toBe(first);
    await first;
    await expect(fixture.store.createWriter(noSignal)).rejects.toThrow(/closed/);
  });
});

describe('Workflow output adversarial lifecycle boundaries', () => {
  it('retains bytes until both independent consumers finish after the last lease is released', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    const first = output.openStream(noSignal);
    const second = output.openStream(noSignal);
    await output.release();
    await first.cancel('No longer needed');
    expect(fixture.store.getUsage()).toMatchObject({ entries: 1, bytes: 4, readers: 1 });
    expect(await readBytes({ stream: second })).toEqual([...bytes]);
    expect(fixture.store.getUsage()).toEqual({ entries: 0, bytes: 0, readers: 0, pendingWriteBytes: 0 });
  });

  it('isolates a consumer read error from another reader', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    fixture.failNext({ operation: 'read', error: new Error('read interrupted') });
    await expect(readBytes({ stream: output.openStream(noSignal) })).rejects.toThrow('read interrupted');
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([...bytes]);
    expect(fixture.store.getUsage().readers).toBe(0);
  });

  it('rejects a pre-cancelled reader without charging a reader slot', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    const output = await writer.seal();
    const controller = new AbortController();
    controller.abort(new Error('skip'));
    expect(() => output.openStream({ signal: controller.signal })).toThrow('skip');
    expect(fixture.store.getUsage().readers).toBe(0);
  });

  it('does not release an in-progress seal or create a second output on a duplicate seal', async () => {
    await using fixture = createOutputStoreFixture({ limits: {} });
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const pause = fixture.pauseNext({ operation: 'close' });
    const first = writer.seal();
    await pause.entered;
    await expect(writer.seal()).rejects.toThrow();
    pause.release();
    const output = await first;
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([...bytes]);
    await output.release();
    await output.release();
    expect(fixture.store.getUsage().entries).toBe(0);
  });

  it('captures its policy independently from later caller mutations', async () => {
    await using fixture = createOutputStoreFixture({ limits: { maxWriteChunkBytes: 4 } });
    fixture.policy.maxWriteChunkBytes = 1;
    const writer = await fixture.store.createWriter(noSignal);
    await writer.write({ chunk: bytes });
    const output = await writer.seal();
    expect(await readBytes({ stream: output.openStream(noSignal) })).toEqual([...bytes]);
  });
});

export const TEST_ONLY = {
};
