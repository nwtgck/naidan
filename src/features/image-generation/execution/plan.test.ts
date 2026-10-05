import { expect, it, vi } from 'vitest';
import { createImageExecutionPlan } from './plan';
import type { ImageExecutionOutcome, PreparedImageExecution } from './types';

function setup() {
  const gate = Promise.withResolvers<ImageExecutionOutcome>();
  const cancel = vi.fn(), updatePreview = vi.fn();
  const start = vi.fn<PreparedImageExecution<{ prompt: string }>['start']>(() => ({ result: gate.promise, cancel, updatePreview }));
  const snapshot = { prompt: 'original' };
  const execution = createImageExecutionPlan({ snapshot, copySnapshot: ({ snapshot }) => ({ ...snapshot }), start });
  const args = { seed: '42', signal: new AbortController().signal, onProgress() {}, onPreview() {} };
  return { execution, snapshot, start, gate, cancel, updatePreview, args };
}
it('copies the accepted snapshot and returns independent inspection copies', () => {
  const { execution, snapshot, start } = setup(); snapshot.prompt = 'changed';
  execution.snapshot.prompt = 'also changed';
  expect(execution.snapshot.prompt).toBe('original'); expect(start).not.toHaveBeenCalled();
});
it('cancel does not permit overlap before physical retirement', async () => {
  const { execution, gate, args, cancel } = setup(); const job = execution.start(args); job.cancel();
  expect(cancel).toHaveBeenCalledOnce(); expect(() => execution.start(args)).toThrow('already running');
  gate.resolve({ status: 'cancelled' }); await job.result;
  expect(() => execution.start(args)).not.toThrow();
});
it('stale handles cannot cancel or reconfigure the next job', async () => {
  const { execution, start, gate, args, cancel, updatePreview } = setup(); const first = execution.start(args);
  gate.resolve({ status: 'cancelled' }); await first.result;
  const next = Promise.withResolvers<ImageExecutionOutcome>(); start.mockReturnValue({ result: next.promise, cancel, updatePreview });
  const second = execution.start(args); first.cancel(); first.updatePreview?.({ settings: { enabled: true, interval: 1, startStep: 1, mode: 'projection', maxEdge: 64 } });
  expect(cancel).not.toHaveBeenCalled(); expect(updatePreview).not.toHaveBeenCalled(); second.cancel(); expect(cancel).toHaveBeenCalledOnce();
  next.resolve({ status: 'cancelled' }); await second.result;
});
it('pre-aborted jobs never call the backend', async () => {
  const { execution, start, args } = setup();
  const job = execution.start({ ...args, signal: AbortSignal.abort() });
  expect(await job.result).toEqual({ status: 'cancelled' }); expect(start).not.toHaveBeenCalled();
});
it('synchronous start failure releases only its own reservation', () => {
  const { execution, start, args } = setup(); start.mockImplementationOnce(() => {
    throw new Error('Unavailable');
  });
  expect(() => execution.start(args)).toThrow('Unavailable'); expect(() => execution.start(args)).not.toThrow();
});
it('a rejected backend result retires the reservation without hiding the error', async () => {
  const { execution, start, gate, args } = setup(); const job = execution.start(args);
  gate.reject(new Error('Backend crashed')); await expect(job.result).rejects.toThrow('Backend crashed');
  start.mockReturnValue({ result: Promise.resolve({ status: 'cancelled' }), cancel() {}, updatePreview: undefined });
  const next = execution.start(args); expect(next.updatePreview).toBeUndefined(); await next.result;
});
it('retains unknown execution metadata on an interrupted image', async () => {
  const { execution, gate, args } = setup(); const job = execution.start(args);
  const recoverable = { png: new Blob(['pixels']), width: 256, height: 256, reported: undefined };
  gate.resolve({ status: 'interrupted', recoverable, message: 'Delivery interrupted' });
  expect(await job.result).toEqual({ status: 'interrupted', recoverable, message: 'Delivery interrupted' });
});
