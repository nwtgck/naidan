import { expect, it, vi } from 'vitest';
import { createLazyImageQuerySession } from './lazy-query-session';
const mocks = vi.hoisted(() => ({ wrap: vi.fn(), release: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({ wrapWorkerRemote: mocks.wrap, releaseWorkerRemote: mocks.release }));

function worker() {
  const events = new EventTarget(); return Object.assign(events, { terminate: vi.fn() }) as unknown as Worker;
}

it('is lazy, shares one pending creation and disposes a worker arriving after the page closes', async () => {
  const gate = Promise.withResolvers<Worker>(), createWorker = vi.fn(() => gate.promise), run = vi.fn(async () => 1);
  const session = createLazyImageQuerySession<object>({ createWorker, createRemote: mocks.wrap }); expect(createWorker).not.toHaveBeenCalled();
  const a = session.invoke({ run }), b = session.invoke({ run });
  const ended = Promise.all([expect(a).rejects.toThrow('disposed'), expect(b).rejects.toThrow('disposed')]);
  expect(createWorker).toHaveBeenCalledOnce(); await session.dispose(); await ended;
  const late = worker(); gate.resolve(late); await vi.waitFor(() => expect(late.terminate).toHaveBeenCalledOnce());
  expect(run).not.toHaveBeenCalled();
});

it('rejects readers on message failure and creates a replacement only on a new explicit query', async () => {
  const workers = [worker(), worker()]; let index = 0;
  const createWorker = vi.fn(async () => workers[index++]!); mocks.wrap.mockReturnValue({});
  const session = createLazyImageQuerySession<object>({ createWorker, createRemote: mocks.wrap });
  const gate = Promise.withResolvers<number>(), run = vi.fn(() => gate.promise);
  const task = session.invoke({ run }), rejected = expect(task).rejects.toThrow('communication failed');
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce()); workers[0]!.dispatchEvent(new Event('messageerror')); await rejected;
  expect(workers[0]!.terminate).toHaveBeenCalledOnce(); expect(createWorker).toHaveBeenCalledOnce();
  expect(await session.invoke({ run: async () => 42 })).toBe(42); expect(createWorker).toHaveBeenCalledTimes(2);
  gate.resolve(1); await session.dispose(); expect(workers[1]!.terminate).toHaveBeenCalledOnce();
});

export const TEST_ONLY = {
};
