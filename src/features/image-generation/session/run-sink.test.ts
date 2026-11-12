import { describe, expect, it, vi } from 'vitest';
import { toBinaryObjectId, toImageGenerationId, toImageGenerationOperationId, toImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationRun } from '@/01-models/image-generation';
import { generationRunFixture } from '@/00-storage/service/image-generation/index.test-support';
import { copyImageGenerationSnapshot, finishImageGenerationSnapshot, type ImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
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
    const seed = plan.seeds[index];
    if (seed === undefined) {
      throw new Error('Missing fixture seed.');
    }
    return {
      index,
      ...finishImageGenerationSnapshot({
        snapshot: { ...snapshot, request: { ...snapshot.request, parameters: { ...snapshot.request.parameters, seed } } },
        result: { png: new Blob(['image']), width: 256, height: 256, modelVersion: 'model', uniformOutput: false },
        previews: [],
        elapsedMs: 10,
      }),
    };
  }
  return { sink, create, commit, update, snapshot, plan, output, accept: () => sink.submission.accepted({ snapshot, seeds: plan.seeds }) };
}

function plannedHarness() {
  const sessionId = toImageGenerationSessionId({ raw: 'session-aa' });
  const operationId = toImageGenerationOperationId({ raw: 'operation-aa' });
  const plannedRun = generationRunFixture({ id: 'planned-run-aa', sessionId, count: 2, seed: '9007199254740993' });
  plannedRun.operationId = operationId;
  const snapshot: ImageGenerationSnapshot = { id: toImageGenerationId({ raw: 'image-aa' }), createdAt: plannedRun.createdAt, request: structuredClone(plannedRun.request), inputFiles: [] };
  const create = vi.fn<ImageGenerationRunPersistence['create']>().mockResolvedValue(undefined);
  const commit = vi.fn<ImageGenerationRunPersistence['commit']>().mockResolvedValue(undefined);
  const update = vi.fn<ImageGenerationRunPersistence['update']>().mockResolvedValue(undefined);
  const sink = createImageGenerationRunSink({ sessionId, operationId, plannedRun, count: 2, sources: [], persistence: { create, commit, update }, changed: vi.fn() });
  return { plannedRun, snapshot, sink, create, update, accept: () => sink.submission.accepted({ snapshot, seeds: [...plannedRun.seeds] }) };
}

describe('Prepared request acceptance', () => {
  it('accepts copied request metadata despite object key order at every level', async () => {
    const h = plannedHarness();
    const copied = copyImageGenerationSnapshot({ snapshot: h.snapshot });
    const { prompt, ...parameters } = copied.request.parameters;
    copied.request.parameters = { ...parameters, prompt };
    const model = copied.request.models[0]!;
    const { name, ...file } = model.file;
    model.file = { ...file, name };
    const { enabled, ...preview } = copied.request.preview;
    copied.request.preview = { ...preview, enabled };
    const runtime = copied.request.runtime;
    if (runtime.profile === 'naidan-rpc') {
      throw new Error('The fixture must use a local runtime.');
    }
    const { sourceCommit, ...runtimeFields } = runtime;
    copied.request.runtime = { ...runtimeFields, sourceCommit };
    await h.sink.submission.accepted({ snapshot: copied, seeds: [...h.plannedRun.seeds] });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.create.mock.calls[0]![0].run).toEqual(h.plannedRun);
    expect(h.sink.snapshot().run).toMatchObject({ id: h.plannedRun.id, execution: { type: 'running' } });
  });

  it('treats an omitted optional setting as its explicit undefined value', async () => {
    const h = plannedHarness();
    h.plannedRun.request.parameters.modelArguments = undefined;
    delete h.snapshot.request.parameters.modelArguments;
    await h.accept();
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.sink.snapshot().run?.id).toBe(h.plannedRun.id);
  });

  const changedRequests: { name: string, change({ run }: { run: ImageGenerationRun }): void }[] = [
    {
      name: 'prompt',
      change({ run }) {
        run.request.parameters.prompt = 'another prompt';
      },
    },
    {
      name: 'negative prompt',
      change({ run }) {
        run.request.parameters.negativePrompt = 'another negative prompt';
      },
    },
    {
      name: 'model file identity',
      change({ run }) {
        run.request.models[0]!.file.lastModified++;
      },
    },
    {
      name: 'model companion',
      change({ run }) {
        run.request.models[0]!.companions[0]!.path = 'other/tokenizer.json';
      },
    },
    {
      name: 'LoRA strength',
      change({ run }) {
        run.request.loras[0]!.strength = 0.5;
      },
    },
    {
      name: 'input image identity',
      change({ run }) {
        run.request.imageInputs.initImage = { binaryObjectId: toBinaryObjectId({ raw: 'different-aa' }), name: 'initial.png' };
      },
    },
    {
      name: 'preview setting',
      change({ run }) {
        run.request.preview.interval++;
      },
    },
    {
      name: 'runtime setting',
      change({ run }) {
        if (run.request.runtime.profile === 'naidan-rpc') {
          throw new Error('The fixture must use a local runtime.');
        }
        run.request.runtime.weightResidency = 'cpu';
      },
    },
    {
      name: 'planned seed',
      change({ run }) {
        run.request.parameters.seed = '42';
      },
    },
  ];

  it.each(changedRequests)('rejects a changed $name before persisting or accepting the run', async ({ change }) => {
    const h = plannedHarness();
    change({ run: h.plannedRun });
    await expect(h.accept()).rejects.toThrow('no longer matches');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.sink.snapshot().run).toBeUndefined();
  });

  it.each(['session', 'operation', 'revision', 'execution'] as const)('rejects a changed %s identity or execution state', async field => {
    const h = plannedHarness();
    switch (field) {
    case 'session': h.plannedRun.sessionId = toImageGenerationSessionId({ raw: 'other-session-aa' });
      break;
    case 'operation': h.plannedRun.operationId = toImageGenerationOperationId({ raw: 'other-operation-aa' });
      break;
    case 'revision': h.plannedRun.revision = 1;
      break;
    case 'execution': h.plannedRun.execution = { type: 'running', startedAt: 1 };
      break;
    default: {
      const exhaustive: never = field;
      throw new Error(String(exhaustive));
    }
    }
    await expect(h.accept()).rejects.toThrow('no longer matches');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sink.snapshot().run).toBeUndefined();
  });

  it.each(['models', 'loras', 'referenceImages'] as const)('preserves the order of %s rather than comparing an unordered set', async field => {
    const h = plannedHarness();
    switch (field) {
    case 'models': {
      const first = h.plannedRun.request.models[0]!;
      h.plannedRun.request.models.push({ ...structuredClone(first), slot: 'vae', path: 'weights/vae.gguf' });
      h.snapshot.request.models = structuredClone(h.plannedRun.request.models).reverse();
      break;
    }
    case 'loras': {
      const first = h.plannedRun.request.loras[0]!;
      h.plannedRun.request.loras.push({ ...structuredClone(first), path: 'second.gguf', strength: 0.5 });
      h.snapshot.request.loras = structuredClone(h.plannedRun.request.loras).reverse();
      break;
    }
    case 'referenceImages':
      h.plannedRun.request.imageInputs.referenceImages.push({ binaryObjectId: toBinaryObjectId({ raw: 'reference-bb' }), name: 'second.png' });
      h.snapshot.request.imageInputs.referenceImages = structuredClone(h.plannedRun.request.imageInputs.referenceImages).reverse();
      break;
    default: {
      const exhaustive: never = field;
      throw new Error(String(exhaustive));
    }
    }
    await expect(h.accept()).rejects.toThrow('no longer matches');
    expect(h.create).not.toHaveBeenCalled();
    expect(h.sink.snapshot().run).toBeUndefined();
  });
});

describe('Workspace run publication ownership', () => {
  it('keeps one run and exact per-image seeds without mutating the accepted request', async () => {
    const h = harness({ count: 3 });
    await h.accept();
    const prompt = h.sink.snapshot().run?.request.parameters.prompt;
    h.snapshot.request.parameters.prompt = 'next draft';
    for (let index = 0; index < 3; index++) {
      await h.sink.submission.output(h.output({ index }));
    }
    await h.sink.submission.finished({ completion: { type: 'completed' } });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(3);
    expect(h.commit.mock.calls.map(([value]) => value.asset.seed)).toEqual(h.plan.seeds);
    expect(new Set(h.commit.mock.calls.map(([value]) => value.asset.runId)).size).toBe(1);
    expect(h.sink.snapshot()).toMatchObject({ run: { revision: 2, request: { parameters: { prompt } }, execution: { type: 'completed' } }, received: 3, pending: [], needsRetry: false });
  });

  it('holds completed pixels after a failed save and retries the same asset identity and bytes', async () => {
    const h = harness({ count: 2 });
    await h.accept();
    await h.sink.submission.output(h.output({ index: 0 }));
    h.commit.mockRejectedValueOnce(new Error('quota'));
    const output = h.output({ index: 1 });
    await expect(h.sink.submission.output(output)).rejects.toThrow('quota');
    await h.sink.submission.finished({ completion: { type: 'failed', message: 'quota' } });
    expect(h.commit).toHaveBeenCalledTimes(2);
    expect(h.sink.snapshot()).toMatchObject({ received: 2, pending: [{ asset: { index: 1 } }], needsRetry: true });
    const attempted = h.commit.mock.calls[1]?.[0];
    await h.sink.retry();
    expect(h.commit.mock.calls[2]?.[0]).toBe(attempted);
    expect(h.sink.snapshot()).toMatchObject({ pending: [], needsRetry: false, run: { execution: { type: 'completed' } } });
  });

  it('does not generate missing outputs when a mid-run save is retried', async () => {
    const h = harness({ count: 4 });
    await h.accept();
    h.commit.mockRejectedValueOnce(new Error('write failed'));
    await expect(h.sink.submission.output(h.output({ index: 0 }))).rejects.toThrow();
    await h.sink.submission.finished({ completion: { type: 'failed', message: 'write failed' } });
    await h.sink.retry();
    expect(h.sink.snapshot()).toMatchObject({ received: 1, run: { seeds: h.plan.seeds, execution: { type: 'failed' } } });
  });

  it.each(['create', 'running', 'terminal'] as const)('retries a lost %s acknowledgement with the same revision', async stage => {
    const h = harness({ count: 1 });
    if (stage === 'create') {
      h.create.mockRejectedValueOnce(new Error('lost acknowledgement'));
    }
    if (stage === 'running') {
      h.update.mockRejectedValueOnce(new Error('lost acknowledgement'));
    }
    if (stage !== 'terminal') {
      await expect(h.accept()).rejects.toThrow();
      await h.sink.submission.finished({ completion: { type: 'failed', message: 'lost acknowledgement' } });
      await h.sink.retry();
      if (stage === 'create') {
        expect(h.create.mock.calls[0]?.[0]).toEqual(h.create.mock.calls[1]?.[0]);
      } else {
        expect(h.update.mock.calls[0]?.[0]).toEqual(h.update.mock.calls[1]?.[0]);
      }
    } else {
      await h.accept();
      await h.sink.submission.output(h.output({ index: 0 }));
      h.update.mockRejectedValueOnce(new Error('lost acknowledgement'));
      await expect(h.sink.submission.finished({ completion: { type: 'completed' } })).rejects.toThrow();
      await h.sink.retry();
      expect(h.update.mock.calls[1]?.[0]).toEqual(h.update.mock.calls[2]?.[0]);
    }
    expect(h.sink.snapshot().needsRetry).toBe(false);
  });

  it('keeps partial output on cancellation and forbids late output', async () => {
    const h = harness({ count: 3 });
    await h.accept();
    await h.sink.submission.output(h.output({ index: 0 }));
    await h.sink.submission.finished({ completion: { type: 'cancelled' } });
    expect(h.sink.snapshot()).toMatchObject({ received: 1, run: { execution: { type: 'cancelled' } } });
    await expect(h.sink.submission.output(h.output({ index: 1 }))).rejects.toThrow('unexpected output');
  });

  it('rejects nonconsecutive output and wrong seeds before holding or committing pixels', async () => {
    const h = harness({ count: 2 });
    await h.accept();
    await expect(h.sink.submission.output(h.output({ index: 1 }))).rejects.toThrow();
    const output = h.output({ index: 0 });
    output.record.request.parameters.seed = '42';
    await expect(h.sink.submission.output(output)).rejects.toThrow();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.sink.snapshot().pending).toEqual([]);
  });

  it('rejects a native plan with the wrong count before creating metadata', async () => {
    const h = harness({ count: 2 });
    await expect(h.sink.submission.accepted({ snapshot: h.snapshot, seeds: [h.plan.seeds[0]!] })).rejects.toThrow('output count');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('does not accept a second request or change a terminal timestamp on repeated completion', async () => {
    const h = harness({ count: 1 });
    await h.accept();
    await expect(h.accept()).rejects.toThrow('one request');
    await h.sink.submission.finished({ completion: { type: 'cancelled' } });
    const run = h.sink.snapshot().run;
    await expect(h.sink.submission.finished({ completion: { type: 'completed' } })).rejects.toThrow('finish once');
    expect(h.sink.snapshot().run).toBe(run);
  });
});

it.each(['interrupted', 'completed', 'cancelled'] as const)('never promotes recovered pixels after a %s completion and save retry', async type => {
  const h = harness({ count: 1 });
  await h.accept();
  const output = h.output({ index: 0 });
  output.record.result = { ...output.record.result, confirmation: 'unconfirmed', modelVersion: undefined, uniformOutput: undefined };
  const onPersisted = vi.fn();
  h.commit.mockRejectedValueOnce(new Error('lost acknowledgement'));
  await expect(h.sink.submission.recovered!({ ...output, onPersisted })).rejects.toThrow('lost acknowledgement');
  expect(h.sink.snapshot()).toMatchObject({ received: 0, recovered: 1 });
  expect(onPersisted).not.toHaveBeenCalled();
  await h.sink.submission.finished({ completion: { type } });
  const attempted = h.commit.mock.calls[0]![0];
  await h.sink.retry();
  expect(h.commit.mock.calls[1]![0]).toBe(attempted);
  expect(onPersisted).toHaveBeenCalledOnce();
  expect(h.sink.snapshot()).toMatchObject({ received: 0, recovered: 1, pending: [], run: { execution: { type: 'interrupted' } } });
});

it('rejects recovered pixels through the successful output path', async () => {
  const h = harness({ count: 1 });
  await h.accept();
  const output = h.output({ index: 0 });
  output.record.result = { ...output.record.result, confirmation: 'unconfirmed' };
  await expect(h.sink.submission.output(output)).rejects.toThrow();
  expect(h.commit).not.toHaveBeenCalled();
});

it('a recovered final image does not discard earlier confirmed images or accept a later image', async () => {
  const h = harness({ count: 3 });
  await h.accept();
  await h.sink.submission.output(h.output({ index: 0 }));
  const output = h.output({ index: 1 });
  output.record.result = { ...output.record.result, confirmation: 'unconfirmed' };
  await h.sink.submission.recovered!({ ...output, onPersisted: vi.fn() });
  await expect(h.sink.submission.output(h.output({ index: 2 }))).rejects.toThrow();
  await h.sink.submission.finished({ completion: { type: 'interrupted' } });
  expect(h.sink.snapshot()).toMatchObject({ received: 1, recovered: 1, run: { execution: { type: 'interrupted' } } });
});
