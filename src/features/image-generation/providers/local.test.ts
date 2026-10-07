// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { prepareLocalImageExecution } from './local';
import { snapshotImageGeneration } from '@/features/image-generation/history/snapshot';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import type { WorkerResult } from '@/features/stable-diffusion-cpp-browser/types';

function setup() {
  const request = requestFixture();
  const snapshot = snapshotImageGeneration({ request, sourceCommit: 'a'.repeat(40), createdAt: 1,
    locateFile: ({ file }) => ({ type: 'file', name: file.name, size: file.size, lastModified: file.lastModified }) });
  const gate = Promise.withResolvers<WorkerResult>();
  const native: ImageClient = { generate: vi.fn(() => gate.promise), cancel: vi.fn(), updatePreview: vi.fn(), dispose: vi.fn(), release: vi.fn(),
    inspectEngine: vi.fn<ImageClient['inspectEngine']>(async () => ({ status: 'unavailable', reason: 'not-loaded' })) };
  const client = vi.fn(() => native), onModelResident = vi.fn();
  const execution = prepareLocalImageExecution({ request, snapshot, client, onDiagnostic() {}, onModelResident });
  const args = { seed: '43', signal: new AbortController().signal, onProgress() {}, onPreview() {} };
  const output = { png: new Blob(['pixels'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test', uniformOutput: false };
  return { request, snapshot, execution, client, native, gate, args, output, onModelResident };
}
it('preparing is lazy and accepted parameters cannot change underneath the job', async () => {
  const { request, execution, native, gate, args, output, client } = setup();
  expect(client).not.toHaveBeenCalled();
  request.parameters.prompt = 'different'; request.models.length = 0;
  const job = execution.start(args);
  const sent = vi.mocked(native.generate).mock.calls[0]![0].request;
  expect(sent.parameters.prompt).toBe('a small tree'); expect(sent.parameters.seed).toBe('43'); expect(sent.models).toHaveLength(1);
  gate.resolve(output); await expect(job.result).resolves.toEqual({ status: 'completed', output });
});
it('rejects overlapping starts without allocating a second native job', async () => {
  const { execution, gate, args, output, native } = setup();
  const first = execution.start(args);
  expect(() => execution.start(args)).toThrow('already running');
  expect(native.generate).toHaveBeenCalledTimes(1); gate.resolve(output); await first.result;
});
it('a completed job handle cannot cancel or change a later image in the same plan', async () => {
  const { execution, gate, args, output, native, request } = setup();
  const first = execution.start(args); gate.resolve(output); await first.result;
  const next = Promise.withResolvers<WorkerResult>(); vi.mocked(native.generate).mockReturnValue(next.promise);
  const second = execution.start({ ...args, seed: '44' });
  first.cancel(); first.updatePreview?.({ settings: request.preview });
  expect(native.cancel).not.toHaveBeenCalled(); expect(native.updatePreview).not.toHaveBeenCalled();
  second.cancel(); expect(native.cancel).toHaveBeenCalledTimes(1);
  next.resolve({ cancelled: true, modelResident: true }); await expect(second.result).resolves.toEqual({ status: 'cancelled' });
});
it('does not create a native client for an already aborted job', async () => {
  const { execution, args, client } = setup(); const stop = new AbortController(); stop.abort();
  await expect(execution.start({ ...args, signal: stop.signal }).result).resolves.toEqual({ status: 'cancelled' });
  expect(client).not.toHaveBeenCalled();
});
it('reports native errors through the same execution result without exposing a worker to the view', async () => {
  const { execution, args, gate } = setup(); const job = execution.start(args);
  gate.reject(new Error('test failure')); await expect(job.result).resolves.toEqual({ status: 'failed', message: 'test failure' });
});
it('retained-model bookkeeping remains in the local adapter', async () => {
  const { execution, args, gate, onModelResident } = setup(); const job = execution.start(args);
  gate.resolve({ cancelled: true, modelResident: false }); await job.result;
  expect(onModelResident).toHaveBeenCalledWith({ resident: false });
});
it('isolates editable snapshot metadata without copying image bytes', () => {
  const { execution, snapshot } = setup();
  snapshot.request.parameters.prompt = 'changed'; snapshot.request.models.length = 0;
  expect(execution.snapshot.request.parameters.prompt).toBe('a small tree'); expect(execution.snapshot.request.models).toHaveLength(1);
  const inspected = execution.snapshot; inspected.request.models[0]!.path = 'changed';
  expect(execution.snapshot.request.models[0]!.path).not.toBe('changed');
});

it('does not publish a cancelled native success as a completed image', async () => {
  const { execution, args, gate, output, onModelResident } = setup(), stop = new AbortController();
  const job = execution.start({ ...args, signal: stop.signal });
  stop.abort(); gate.resolve(output);
  await expect(job.result).resolves.toEqual({ status: 'cancelled' });
  expect(onModelResident).toHaveBeenCalledWith({ resident: true });
});
