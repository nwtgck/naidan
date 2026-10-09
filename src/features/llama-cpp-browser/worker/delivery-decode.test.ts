import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryDecode } from './delivery-decode';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

async function tick(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('one delivery paired with one decode', () => {
  it.each(['delivery', 'decode'] as const)('waits for both operations when %s finishes first', async first => {
    const pair = createDeliveryDecode({ mode: 'overlap', signal: undefined, now: undefined });
    const delivery = Promise.withResolvers<void>(); const native = Promise.withResolvers<void>();
    const order: string[] = []; let finished = false;
    const task = pair.run({
      deliver: () => {
        order.push('deliver'); return delivery.promise;
      },
      decode: () => {
        order.push('decode'); return native.promise;
      },
    }).finally(() => {
      finished = true;
    });
    expect(order).toEqual(['deliver']);
    await tick(); expect(order).toEqual(['deliver', 'decode']);
    await expect(pair.run({ deliver: () => {}, decode: async () => {} })).rejects.toThrow('busy');
    (first === 'delivery' ? delivery : native).resolve(); await tick(); expect(finished).toBe(false);
    (first === 'delivery' ? native : delivery).resolve(); await task;
    expect(pair.counters).toMatchObject({ pairedSteps: 1, settledPairs: 1, serialSteps: 0 });
    await pair.run({ deliver: () => {}, decode: async () => {} });
    expect(pair.counters.settledPairs).toBe(2);
  });

  const outcomes = ['ok', 'reject'] as const;
  for (const delivered of outcomes) for (const decoded of outcomes) {
    it.each(['delivery', 'decode'] as const)(`drains ${delivered}/${decoded} with %s finishing first`, async first => {
      const pair = createDeliveryDecode({ mode: 'overlap', signal: undefined, now: undefined });
      const delivery = Promise.withResolvers<void>(); const native = Promise.withResolvers<void>();
      const deliveryError = new Error('delivery'); const decodeError = new Error('decode');
      let ended = false;
      const task = pair.run({ deliver: () => delivery.promise, decode: () => native.promise });
      const observed = task.then(() => ({ status: 'ok' as const }), error => ({ status: 'error' as const, error })).finally(() => {
        ended = true;
      });
      await tick();
      const settleDelivery = () => {
        if (delivered === 'ok') delivery.resolve(); else delivery.reject(deliveryError);
      };
      const settleDecode = () => {
        if (decoded === 'ok') native.resolve(); else native.reject(decodeError);
      };
      (first === 'delivery' ? settleDelivery : settleDecode)();
      await tick(); expect(ended).toBe(false);
      (first === 'delivery' ? settleDecode : settleDelivery)();
      expect(await observed).toEqual(delivered === 'reject' ? { status: 'error', error: deliveryError }
        : decoded === 'reject' ? { status: 'error', error: decodeError } : { status: 'ok' });
      expect(pair.counters.settledPairs).toBe(1);
    });
  }

  it.each(['throw', 'reject'] as const)('does not decode after an immediately known delivery %s', async failure => {
    const pair = createDeliveryDecode({ mode: 'overlap', signal: undefined, now: undefined });
    const error = new Error('failed delivery'); const decode = vi.fn(async () => {});
    await expect(pair.run({
      deliver: () => {
        if (failure === 'throw') throw error; return Promise.reject(error);
      },
      decode,
    })).rejects.toBe(error);
    expect(decode).not.toHaveBeenCalled();
  });

  it('keeps an undefined rejection distinct from successful delivery', async () => {
    const pair = createDeliveryDecode({ mode: 'overlap', signal: undefined, now: undefined });
    const decode = vi.fn(async () => {});
    await expect(pair.run({ deliver: () => Promise.reject(undefined), decode })).rejects.toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
  });

  it('waits for delivery after a synchronous native exception', async () => {
    const pair = createDeliveryDecode({ mode: 'overlap', signal: undefined, now: undefined });
    const delivery = Promise.withResolvers<void>(); let ended = false;
    const error = new Error('decode setup');
    const result = pair.run({
      deliver: () => delivery.promise,
      decode: () => {
        throw error;
      },
    }).catch(reason => {
      ended = true; return reason;
    });
    await tick(); expect(ended).toBe(false);
    delivery.resolve(); expect(await result).toBe(error);
  });

  it('does not invoke anything for a pre-aborted request', async () => {
    const controller = new AbortController(); controller.abort();
    const pair = createDeliveryDecode({ mode: 'overlap', signal: controller.signal, now: undefined });
    const deliver = vi.fn(); const decode = vi.fn(async () => {});
    await expect(pair.run({ deliver, decode })).rejects.toThrow('aborted');
    expect(deliver).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    expect(pair.counters.pairedSteps).toBe(0);
  });

  it('does not decode after synchronous cancellation from delivery', async () => {
    const controller = new AbortController();
    const pair = createDeliveryDecode({ mode: 'overlap', signal: controller.signal, now: undefined });
    const decode = vi.fn(async () => {});
    await expect(pair.run({
      deliver: () => {
        controller.abort();
      },
      decode,
    })).rejects.toThrow('aborted');
    expect(decode).not.toHaveBeenCalled(); expect(pair.counters.settledPairs).toBe(1);
  });

  it.each(['delivery', 'decode'] as const)('does not race cancellation with the still-pending %s', async pending => {
    const controller = new AbortController();
    const pair = createDeliveryDecode({ mode: 'overlap', signal: controller.signal, now: undefined });
    const delivery = Promise.withResolvers<void>(); const native = Promise.withResolvers<void>(); let ended = false;
    const task = pair.run({ deliver: () => delivery.promise, decode: () => native.promise }).catch(error => {
      ended = true; return error;
    });
    await tick(); controller.abort();
    (pending === 'delivery' ? native : delivery).resolve(); await tick(); expect(ended).toBe(false);
    (pending === 'delivery' ? delivery : native).resolve(); expect((await task).message).toContain('aborted');
  });

  it('blocks reentry from delivery and retains the outer ownership', async () => {
    const pair = createDeliveryDecode({ mode: 'overlap', signal: undefined, now: undefined });
    const innerDecode = vi.fn(async () => {}); const outerDecode = vi.fn(async () => {});
    await pair.run({ deliver: () => expect(pair.run({ deliver: () => {}, decode: innerDecode })).rejects.toThrow('busy'), decode: outerDecode });
    expect(innerDecode).not.toHaveBeenCalled(); expect(outerDecode).toHaveBeenCalledOnce();
  });

  it('retains serial backpressure without speculative native calls', async () => {
    const pair = createDeliveryDecode({ mode: 'serial', signal: undefined, now: undefined });
    const delivery = Promise.withResolvers<void>(); const decode = vi.fn(async () => {});
    const task = pair.run({ deliver: () => delivery.promise, decode });
    await tick(); expect(decode).not.toHaveBeenCalled(); delivery.resolve(); await task;
    expect(decode).toHaveBeenCalledOnce(); expect(pair.counters).toMatchObject({ pairedSteps: 0, settledPairs: 0, serialSteps: 1 });
  });

  it.each(['cancel', 'failure'] as const)('preserves serial %s before decode', async outcome => {
    const controller = new AbortController();
    const pair = createDeliveryDecode({ mode: 'serial', signal: controller.signal, now: undefined });
    const decode = vi.fn(async () => {});
    await expect(pair.run({
      deliver: () => {
        if (outcome === 'cancel') controller.abort(); else throw new Error('failure');
      },
      decode,
    }))
      .rejects.toThrow(outcome === 'cancel' ? 'aborted' : 'failure');
    expect(decode).not.toHaveBeenCalled();
  });

  it('records overlapping child waits separately from the joint duration', async () => {
    vi.useFakeTimers();
    const pair = createDeliveryDecode({ mode: 'overlap', signal: undefined, now: () => Date.now() });
    const task = pair.run({
      deliver: () => new Promise<void>(resolve => setTimeout(resolve, 20)),
      decode: () => new Promise<void>(resolve => setTimeout(resolve, 30)),
    });
    await vi.advanceTimersByTimeAsync(30); await task;
    expect(pair.counters).toMatchObject({ deliveryWaitMs: 20, decodeWaitMs: 30, jointWaitMs: 30 });
  });

  it.each([Number.NaN, Infinity, -Infinity, 'throw'] as const)('ignores diagnostic clock failure %s without abandoning work', async value => {
    const pair = createDeliveryDecode({
      mode: 'overlap',
      signal: undefined,
      now: () => {
        if (value === 'throw') throw new Error('clock'); return value;
      },
    });
    const decode = vi.fn(async () => {});
    await pair.run({ deliver: () => {}, decode });
    expect(decode).toHaveBeenCalledOnce(); expect(pair.counters).toMatchObject({ settledPairs: 1, jointWaitMs: 0 });
  });
});

describe('delivery/decode error identity during cancellation', () => {
  it.each(['serial', 'overlap'] as const)('preserves a synchronous delivery failure in %s mode', async mode => {
    const controller = new AbortController();
    const failure = new Error('delivery failed');
    const decode = vi.fn(async () => {});
    const pair = createDeliveryDecode({ mode, signal: controller.signal, now: undefined });
    await expect(pair.run({
      deliver: () => {
        controller.abort(); throw failure;
      },
      decode,
    })).rejects.toBe(failure);
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['ok', 'abort', 'failure'] as const)('keeps a native failure after cancellation with %s delivery', async deliveryOutcome => {
    const controller = new AbortController();
    const delivery = Promise.withResolvers<void>(); const native = Promise.withResolvers<void>();
    const decodeFailure = new WebAssembly.RuntimeError('decode trap');
    const deliveryFailure = new Error('delivery failed');
    const pair = createDeliveryDecode({ mode: 'overlap', signal: controller.signal, now: undefined });
    let finished = false;
    const pending = pair.run({ deliver: () => delivery.promise, decode: () => native.promise }).catch(error => {
      finished = true; return error;
    });
    await tick(); controller.abort(); native.reject(decodeFailure);
    await tick(); expect(finished).toBe(false);
    switch (deliveryOutcome) {
    case 'ok': delivery.resolve(); break;
    case 'abort': delivery.reject(new LlamaCppBrowserError({ code: 'aborted' })); break;
    case 'failure': delivery.reject(deliveryFailure); break;
    default: { const exhaustive: never = deliveryOutcome; throw new Error(String(exhaustive)); }
    }
    expect(await pending).toBe(deliveryOutcome === 'failure' ? deliveryFailure : decodeFailure);
    expect(pair.counters.settledPairs).toBe(1);
  });
});

it('keeps serial child waits unavailable while preserving genuine measured overlap zeros', async () => {
  const now = vi.fn(() => 10);
  const serial = createDeliveryDecode({ mode: 'serial', signal: undefined, now });
  await serial.run({ deliver: () => {}, decode: async () => {} });
  expect(serial.counters).toMatchObject({ serialSteps: 1, pairedSteps: 0, deliveryWaitMs: undefined, decodeWaitMs: undefined, jointWaitMs: undefined });
  expect(now).not.toHaveBeenCalled();
  const overlap = createDeliveryDecode({ mode: 'overlap', signal: undefined, now });
  await overlap.run({ deliver: () => {}, decode: async () => {} });
  expect(overlap.counters).toMatchObject({ serialSteps: 0, settledPairs: 1, deliveryWaitMs: 0, decodeWaitMs: 0, jointWaitMs: 0 });
  expect(now).toHaveBeenCalled();
});
