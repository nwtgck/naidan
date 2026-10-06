import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import { expect, it, vi } from 'vitest';
import { createInferenceLifetime } from './inference-lifetime';
import type { OwnedInferenceResources } from '@/features/naidan-peer-rpc/handlers/inference/resources';

function resource(): OwnedInferenceResources {
  return { listChatModels: vi.fn(async () => []), listImageModels: vi.fn(async () => []),
    generateChat: vi.fn<OwnedInferenceResources['generateChat']>(async () => ({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' })),
    generateImage: vi.fn(async () => {
      throw new Error('Unused image method');
    }), dispose: vi.fn() };
}
it('does not import resources when constructed or when an unused feature stops', async () => {
  const load = vi.fn(async () => resource());
  const owner = createInferenceLifetime({ load, budgets: [] });
  await owner.retire(); expect(load).not.toHaveBeenCalled();
});
it('shares one lazy resource owner across calls and retires it once', async () => {
  const native = resource(), load = vi.fn(async () => native);
  const owner = createInferenceLifetime({ load, budgets: [] });
  const signal = new AbortController().signal;
  await Promise.all([owner.resources.listChatModels({ signal }), owner.resources.listImageModels({ signal })]);
  expect(load).toHaveBeenCalledOnce();
  await Promise.all([owner.retire(), owner.retire()]); expect(native.dispose).toHaveBeenCalledOnce();
});
it('a cancelled call cannot enter a native method after its import completes', async () => {
  const native = resource(), gate = Promise.withResolvers<OwnedInferenceResources>();
  const owner = createInferenceLifetime({ load: () => gate.promise, budgets: [] }), stop = new AbortController();
  const call = owner.resources.listImageModels({ signal: stop.signal });
  const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' });
  stop.abort(); gate.resolve(native); await rejected;
  expect(native.listImageModels).not.toHaveBeenCalled();
  await owner.retire(); expect(native.dispose).toHaveBeenCalledOnce();
});
it('retirement fences a pending import and joins repeated retirement requests', async () => {
  const native = resource(), gate = Promise.withResolvers<OwnedInferenceResources>();
  const owner = createInferenceLifetime({ load: () => gate.promise, budgets: [] });
  const call = owner.resources.listImageModels({ signal: new AbortController().signal });
  const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' });
  const first = owner.retire(), second = owner.retire();
  let retired = false; void second.then(() => {
    retired = true;
  });
  await Promise.resolve(); expect(retired).toBe(false);
  gate.resolve(native); await Promise.all([first, second, rejected]);
  expect(native.dispose).toHaveBeenCalledOnce(); expect(native.listImageModels).not.toHaveBeenCalled();
});
it('an old import cannot dispose or supply a newer generation', async () => {
  const old = resource(), next = resource(), gate = Promise.withResolvers<OwnedInferenceResources>();
  const load = vi.fn<() => Promise<OwnedInferenceResources>>().mockImplementationOnce(() => gate.promise).mockResolvedValue(next);
  const owner = createInferenceLifetime({ load, budgets: [] }), signal = new AbortController().signal;
  const abandoned = owner.resources.listImageModels({ signal });
  const rejected = expect(abandoned).rejects.toThrow('retired');
  const retirement = owner.retire();
  await owner.resources.listImageModels({ signal });
  gate.resolve(old); await retirement; await rejected;
  expect(old.dispose).toHaveBeenCalledOnce(); expect(next.dispose).not.toHaveBeenCalled();
  expect(next.listImageModels).toHaveBeenCalledOnce(); await owner.retire(); expect(next.dispose).toHaveBeenCalledOnce();
});
it('a failed import can be retried by a later explicit call', async () => {
  const native = resource(), load = vi.fn<() => Promise<OwnedInferenceResources>>().mockRejectedValueOnce(new Error('load failed')).mockResolvedValue(native);
  const owner = createInferenceLifetime({ load, budgets: [] }), signal = new AbortController().signal;
  await expect(owner.resources.listChatModels({ signal })).rejects.toThrow('load failed');
  await owner.resources.listChatModels({ signal }); expect(native.listChatModels).toHaveBeenCalledOnce(); await owner.retire();
});
it('already cancelled calls do not import a provider', async () => {
  const load = vi.fn(async () => resource()), owner = createInferenceLifetime({ load, budgets: [] });
  await expect(owner.resources.listChatModels({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(load).not.toHaveBeenCalled();
});
it('native disposal failure is not reported as successful retirement', async () => {
  const native = resource(); vi.mocked(native.dispose).mockImplementation(() => {
    throw new Error('dispose failed');
  });
  const owner = createInferenceLifetime({ load: async () => native, budgets: [] });
  await owner.resources.listChatModels({ signal: new AbortController().signal });
  await expect(owner.retire()).rejects.toThrow('dispose failed');
});

it('does not forget a failed native disposal on a later retirement request', async () => {
  const native = resource(), failure = new Error('native release failed');
  vi.mocked(native.dispose).mockRejectedValue(failure);
  const owner = createInferenceLifetime({ load: async () => native, budgets: [] });
  await owner.resources.listChatModels({ signal: new AbortController().signal });
  await expect(owner.retire()).rejects.toBe(failure);
  await expect(owner.retire()).rejects.toBe(failure);
  await expect(owner.resources.listChatModels({ signal: new AbortController().signal })).rejects.toBe(failure);
  expect(native.dispose).toHaveBeenCalledOnce();
});
it('waits for a slow retired generation even if another disposal fails', async () => {
  const old = resource(), next = resource(), slow = Promise.withResolvers<void>();
  const failure = new Error('second owner failed');
  vi.mocked(old.dispose).mockReturnValue(slow.promise);
  vi.mocked(next.dispose).mockRejectedValue(failure);
  const load = vi.fn<() => Promise<OwnedInferenceResources>>().mockResolvedValueOnce(old).mockResolvedValue(next);
  const owner = createInferenceLifetime({ load, budgets: [] }), signal = new AbortController().signal;
  await owner.resources.listChatModels({ signal }); const first = owner.retire();
  await owner.resources.listChatModels({ signal }); const second = owner.retire();
  const failed = expect(second).rejects.toBe(failure);
  let settled = false; void second.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  await vi.waitFor(() => expect(next.dispose).toHaveBeenCalledOnce());
  expect(settled).toBe(false); slow.resolve();
  await Promise.allSettled([first]); await failed;
});
it('keeps retirement pending for delivery cleanup after native disposal fails', async () => {
  const budget = createInferenceBudget({ capacity: 8 }), reservation = budget.reserve({ bytes: 8 });
  const native = resource(), failure = new Error('native disposal failed');
  vi.mocked(native.dispose).mockRejectedValue(failure);
  const owner = createInferenceLifetime({ load: async () => native, budgets: [budget] });
  await owner.resources.listChatModels({ signal: new AbortController().signal });
  const ending = owner.retire(), failed = expect(ending).rejects.toBe(failure);
  let done = false; void ending.then(() => {
    done = true;
  }, () => {
    done = true;
  });
  await vi.waitFor(() => expect(native.dispose).toHaveBeenCalledOnce()); expect(done).toBe(false);
  reservation.release(); await failed;
});
it('waits for input and output owners without importing an unused native provider', async () => {
  const input = createInferenceBudget({ capacity: 8 }), output = createInferenceBudget({ capacity: 8 });
  const incoming = input.reserve({ bytes: 3 }), outgoing = output.reserve({ bytes: 8 });
  const load = vi.fn(async () => resource()), owner = createInferenceLifetime({ load, budgets: [input, output] });
  let done = false; const ending = owner.retire().then(() => {
    done = true;
  });
  incoming.release(); await Promise.resolve(); expect(done).toBe(false);
  outgoing.release(); await ending; expect(done).toBe(true); expect(load).not.toHaveBeenCalled();
});
