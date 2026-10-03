import { describe, expect, it, vi } from 'vitest';
import { toImageGenerationId, toImageGenerationSessionId } from '@/01-models/ids';
import { generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { finishImageGenerationSnapshot, type ImageGenerationSnapshot } from '@/features/stable-diffusion-cpp-browser/history/snapshot';
import { createImageGenerationRunSink, type ImageGenerationRunPersistence } from './run-sink';

function harness({ count }: { count: number }) {
  const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });
  const plan = generationRunFixture({ id: 'unused-run-aa', sessionId, count, seed: '9007199254740993' });
  const snapshot: ImageGenerationSnapshot = { id: toImageGenerationId({ raw: 'legacy-aa' }), createdAt: 1, request: plan.request, inputFiles: [] };
  const create = vi.fn<ImageGenerationRunPersistence['create']>().mockResolvedValue(undefined);
  const commit = vi.fn<ImageGenerationRunPersistence['commit']>().mockResolvedValue(undefined);
  const update = vi.fn<ImageGenerationRunPersistence['update']>().mockResolvedValue(undefined);
  const sink = createImageGenerationRunSink({ sessionId, count, sources: [], persistence: { create, commit, update }, changed: vi.fn() });
  function output({ index }: { index: number }) {
    const seed = plan.seeds[index]; if (seed === undefined) throw new Error('Missing fixture seed.');
    return { index, ...finishImageGenerationSnapshot({ snapshot: { ...snapshot, request: { ...snapshot.request, parameters: { ...snapshot.request.parameters, seed } } },
      result: { png: new Blob(['image']), width: 256, height: 256, modelVersion: 'model', uniformOutput: false }, previews: [], elapsedMs: 10 }) };
  }
  return { sink, create, commit, update, snapshot, plan, output, accept: () => sink.submission.accepted({ snapshot, seeds: plan.seeds }) };
}
describe('Workspace run publication ownership', () => {
  it('keeps one run and exact per-image seeds without mutating the accepted request', async () => {
    const h = harness({ count: 3 }); await h.accept();
    const prompt = h.sink.snapshot().run?.request.parameters.prompt;
    h.snapshot.request.parameters.prompt = 'next draft';
    for (let index = 0; index < 3; index++) await h.sink.submission.output(h.output({ index }));
    await h.sink.submission.finished({ completion: { type: 'completed' } });
    expect(h.create).toHaveBeenCalledTimes(1); expect(h.commit).toHaveBeenCalledTimes(3);
    expect(h.commit.mock.calls.map(([value]) => value.asset.seed)).toEqual(h.plan.seeds);
    expect(new Set(h.commit.mock.calls.map(([value]) => value.asset.runId)).size).toBe(1);
    expect(h.sink.snapshot()).toMatchObject({ run: { revision: 2, request: { parameters: { prompt } }, execution: { type: 'completed' } }, received: 3, pending: [], needsRetry: false });
  });
  it('holds completed pixels after a failed save and retries the same asset identity and bytes', async () => {
    const h = harness({ count: 2 }); await h.accept();
    await h.sink.submission.output(h.output({ index: 0 }));
    h.commit.mockRejectedValueOnce(new Error('quota'));
    const output = h.output({ index: 1 }); await expect(h.sink.submission.output(output)).rejects.toThrow('quota');
    await h.sink.submission.finished({ completion: { type: 'failed', message: 'quota' } });
    expect(h.commit).toHaveBeenCalledTimes(2); expect(h.sink.snapshot()).toMatchObject({ received: 2, pending: [{ asset: { index: 1 } }], needsRetry: true });
    const attempted = h.commit.mock.calls[1]?.[0];
    await h.sink.retry();
    expect(h.commit.mock.calls[2]?.[0]).toBe(attempted);
    expect(h.sink.snapshot()).toMatchObject({ pending: [], needsRetry: false, run: { execution: { type: 'completed' } } });
  });
  it('does not generate missing outputs when a mid-run save is retried', async () => {
    const h = harness({ count: 4 }); await h.accept();
    h.commit.mockRejectedValueOnce(new Error('write failed'));
    await expect(h.sink.submission.output(h.output({ index: 0 }))).rejects.toThrow();
    await h.sink.submission.finished({ completion: { type: 'failed', message: 'write failed' } });
    await h.sink.retry();
    expect(h.sink.snapshot()).toMatchObject({ received: 1, run: { seeds: h.plan.seeds, execution: { type: 'failed' } } });
  });
  it.each(['create', 'running', 'terminal'] as const)('retries a lost %s acknowledgement with the same revision', async stage => {
    const h = harness({ count: 1 });
    if (stage === 'create') h.create.mockRejectedValueOnce(new Error('lost acknowledgement'));
    if (stage === 'running') h.update.mockRejectedValueOnce(new Error('lost acknowledgement'));
    if (stage !== 'terminal') {
      await expect(h.accept()).rejects.toThrow();
      await h.sink.submission.finished({ completion: { type: 'failed', message: 'lost acknowledgement' } });
      await h.sink.retry();
      if (stage === 'create') expect(h.create.mock.calls[0]?.[0]).toEqual(h.create.mock.calls[1]?.[0]);
      else expect(h.update.mock.calls[0]?.[0]).toEqual(h.update.mock.calls[1]?.[0]);
    } else {
      await h.accept(); await h.sink.submission.output(h.output({ index: 0 }));
      h.update.mockRejectedValueOnce(new Error('lost acknowledgement'));
      await expect(h.sink.submission.finished({ completion: { type: 'completed' } })).rejects.toThrow();
      await h.sink.retry();
      expect(h.update.mock.calls[1]?.[0]).toEqual(h.update.mock.calls[2]?.[0]);
    }
    expect(h.sink.snapshot().needsRetry).toBe(false);
  });
  it('keeps partial output on cancellation and forbids late output', async () => {
    const h = harness({ count: 3 }); await h.accept(); await h.sink.submission.output(h.output({ index: 0 }));
    await h.sink.submission.finished({ completion: { type: 'cancelled' } });
    expect(h.sink.snapshot()).toMatchObject({ received: 1, run: { execution: { type: 'cancelled' } } });
    await expect(h.sink.submission.output(h.output({ index: 1 }))).rejects.toThrow('unexpected output');
  });
  it('rejects nonconsecutive output and wrong seeds before holding or committing pixels', async () => {
    const h = harness({ count: 2 }); await h.accept();
    await expect(h.sink.submission.output(h.output({ index: 1 }))).rejects.toThrow();
    const output = h.output({ index: 0 }); output.record.request.parameters.seed = '42';
    await expect(h.sink.submission.output(output)).rejects.toThrow();
    expect(h.commit).not.toHaveBeenCalled(); expect(h.sink.snapshot().pending).toEqual([]);
  });
  it('rejects a native plan with the wrong count before creating metadata', async () => {
    const h = harness({ count: 2 });
    await expect(h.sink.submission.accepted({ snapshot: h.snapshot, seeds: [h.plan.seeds[0]!] })).rejects.toThrow('output count');
    expect(h.create).not.toHaveBeenCalled();
  });
  it('does not accept a second request or change a terminal timestamp on repeated completion', async () => {
    const h = harness({ count: 1 }); await h.accept();
    await expect(h.accept()).rejects.toThrow('one request');
    await h.sink.submission.finished({ completion: { type: 'cancelled' } });
    const run = h.sink.snapshot().run;
    await expect(h.sink.submission.finished({ completion: { type: 'completed' } })).rejects.toThrow('finish once');
    expect(h.sink.snapshot().run).toBe(run);
  });
});
