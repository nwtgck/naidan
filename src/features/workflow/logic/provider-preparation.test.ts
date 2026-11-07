import { describe, expect, it, vi } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import { prepareWorkflowProvider } from './provider-preparation';

function fixture() {
  const controller = new AbortController();
  const provider: LmProvider = {
    listModels: vi.fn(async () => []),
    chat: vi.fn(async function* () {
      yield { type: 'result' as const, result: { type: 'finished' as const, next: 'user' as const } };
    }),
  };
  const gate = Promise.withResolvers<LmProvider>();
  const load = vi.fn(() => gate.promise);
  return {
    controller,
    provider,
    gate,
    load,
    [Symbol.dispose]() {
      controller.abort();
      gate.resolve(provider);
    },
  };
}

describe('Workflow provider preparation ownership', () => {
  it('returns a ready provider and removes its abort listener', async () => {
    using test = fixture();
    const add = vi.spyOn(test.controller.signal, 'addEventListener'), remove = vi.spyOn(test.controller.signal, 'removeEventListener');
    using spies = {
      [Symbol.dispose]() {
        add.mockRestore();
        remove.mockRestore();
      },
    };
    const pending = prepareWorkflowProvider({ signal: test.controller.signal, load: test.load });
    test.gate.resolve(test.provider);
    expect(await pending).toBe(test.provider);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    expect(spies).toBeDefined();
  });

  it('does not start loading when already stopped or stopped before the load microtask', async () => {
    using test = fixture();
    const pending = prepareWorkflowProvider({ signal: test.controller.signal, load: test.load });
    test.controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    await expect(prepareWorkflowProvider({ signal: test.controller.signal, load: test.load })).rejects.toThrow('stopped');
    expect(test.load).not.toHaveBeenCalled();
  });

  it('stops waiting without needing the shared module load to settle', async () => {
    using test = fixture();
    const pending = prepareWorkflowProvider({ signal: test.controller.signal, load: test.load });
    await Promise.resolve();
    expect(test.load).toHaveBeenCalledOnce();
    test.controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    // The gate is deliberately still pending until fixture disposal.
    expect(test.provider.chat).not.toHaveBeenCalled();
  });

  it('observes late loader rejection after stopping', async () => {
    using test = fixture();
    const pending = prepareWorkflowProvider({ signal: test.controller.signal, load: test.load });
    await Promise.resolve();
    test.controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    test.gate.reject(new Error('late import failure'));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not return a provider resolved just before cancellation wins the microtask boundary', async () => {
    using test = fixture();
    const pending = prepareWorkflowProvider({ signal: test.controller.signal, load: test.load });
    await Promise.resolve();
    test.gate.resolve(test.provider);
    test.controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
  });

  it('handles a synchronous loader failure and a synchronous abort inside the loader', async () => {
    using test = fixture();
    await expect(prepareWorkflowProvider({
      signal: test.controller.signal,
      load: () => {
        throw new Error('failed import');
      },
    })).rejects.toThrow('failed import');
    await expect(prepareWorkflowProvider({
      signal: test.controller.signal,
      load: () => {
        test.controller.abort(new Error('stopped'));
        throw new Error('late failure');
      },
    })).rejects.toThrow('stopped');
  });
});
