// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { observeNativeStreamer, type NativeStreamRecorder } from './native-streamer-capture';

type Runtime = typeof import('@huggingface/transformers');
let runtime: Runtime;
const forbiddenFetch = vi.fn(() => {
  throw new Error('External network forbidden');
});
beforeAll(async () => {
  vi.stubGlobal('fetch', forbiddenFetch);
  const artifact = await getProductionTransformersArtifact();
  expect(artifact.originalBundleSha256).toBe('25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff');
  expect(artifact.transformedBundleSha256).toBe('6b6a707a7163365ac1bbee232e4228b8177dd05b11e825c061167d56d986070f');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
  const originalProcess = globalThis.process;
  Object.defineProperty(globalThis, 'process', { configurable: true, writable: true, value: { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } } });
  try {
    runtime = await importProductionTransformersArtifact({ moduleUrl: `${artifact.moduleUrl}?capture=native-streamer` }) as Runtime;
  } finally {
    Object.defineProperty(globalThis, 'process', descriptor);
  }
}, 30_000);
afterAll(() => {
  try {
    expect(forbiddenFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

function recorder() {
  return { setNativeStreamAvailability: vi.fn<NativeStreamRecorder['setNativeStreamAvailability']>(), recordNativeStream: vi.fn<NativeStreamRecorder['recordNativeStream']>() };
}

function syntheticStreamer() {
  const returned = {};
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  class Streamer {
    put(...args: unknown[]) {
      calls.push({ receiver: this, args }); return returned;
    }
    end(...args: unknown[]) {
      calls.push({ receiver: this, args }); return returned;
    }
    on_finalized_text(...args: unknown[]) {
      calls.push({ receiver: this, args }); return returned;
    }
  }
  return { streamer: new Streamer(), prototype: Streamer.prototype, calls, returned };
}

describe('native streamer instance call-through', () => {
  it('observes actual prompt and generated put groups without changing decode or visible callback counts', () => {
    const decode = vi.fn((ids: bigint[]) => ids.map(id => id === 2n ? 'a' : 'b ').join(''));
    const output = vi.fn();
    const tokenizer = { all_special_ids: [], decode } as never;
    const ordinary = new runtime.TextStreamer(tokenizer, { skip_prompt: true, callback_function: output });
    ordinary.put([[1n]]);
    ordinary.put([[2n, 3n]]);
    ordinary.end();
    const originalDecodeCalls = structuredClone(decode.mock.calls);
    const originalOutputs = structuredClone(output.mock.calls);
    decode.mockClear(); output.mockClear();
    const observed = new runtime.TextStreamer(tokenizer, { skip_prompt: true, callback_function: output });
    const capture = recorder();
    const hook = observeNativeStreamer({ streamer: observed, streamerPrototype: runtime.TextStreamer.prototype, capture });
    observed.put([[1n]]);
    observed.put([[2n, 3n]]);
    observed.end();
    hook.restore();
    expect(decode.mock.calls).toEqual(originalDecodeCalls);
    expect(output.mock.calls).toEqual(originalOutputs);
    const puts = capture.recordNativeStream.mock.calls.map(([event]) => event).filter(event => event.operation === 'put' && event.phase === 'entering');
    expect(puts.map(event => event.args[0])).toEqual([[[1n]], [[2n, 3n]]]);
  });

  it('observes actual finalized text and stream_end before the original callback including empty end text', () => {
    const order: string[] = [];
    const capture = recorder();
    capture.recordNativeStream.mockImplementation(event => {
      order.push(`${event.operation}:${event.phase}`);
    });
    const streamer = new runtime.TextStreamer({ all_special_ids: [], decode: () => 'tail' } as never, {
      skip_prompt: true, callback_function: () => {
        order.push('callback');
      },
    });
    const hook = observeNativeStreamer({ streamer, streamerPrototype: runtime.TextStreamer.prototype, capture });
    streamer.on_finalized_text('actual text', false);
    streamer.end();
    hook.restore();
    expect(order).toEqual(['on_finalized_text:entering', 'callback', 'on_finalized_text:returned', 'end:entering', 'on_finalized_text:entering', 'on_finalized_text:returned', 'end:returned']);
    expect(capture.recordNativeStream.mock.calls.filter(([event]) => event.operation === 'on_finalized_text' && event.phase === 'entering').map(([event]) => event.args)).toEqual([['actual text', false], ['', true]]);
  });

  it('preserves original receiver, argument identities, grouped tokens, and return identity', () => {
    const fixture = syntheticStreamer();
    const capture = recorder();
    const hook = observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture });
    const tokens = [[9007199254740993n, 7n], [8n]];
    const receiver = {};
    expect(Reflect.apply(fixture.streamer.put, receiver, [tokens])).toBe(fixture.returned);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.receiver).toBe(receiver);
    expect(fixture.calls[0]?.args[0]).toBe(tokens);
    expect(capture.recordNativeStream.mock.calls.map(([event]) => [event.operation, event.phase, event.streamCallOrdinal])).toEqual([['put', 'entering', 1], ['put', 'returned', 1]]);
    hook.restore();
  });

  it('rethrows the identical put exception without synthesizing end', () => {
    const failure = new Error('Synthetic put failure');
    // All supported methods are inherited data methods; this independent class
    // exercises only the call-through exception contract, not runtime decoding.
    class ThrowingStreamer {
      put() {
        throw failure;
      } end() {} on_finalized_text() {}
    }
    const streamer = new ThrowingStreamer(); const capture = recorder();
    const hook = observeNativeStreamer({ streamer, streamerPrototype: ThrowingStreamer.prototype, capture });
    let thrown: unknown;
    try {
      streamer.put();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(capture.recordNativeStream.mock.calls.map(([event]) => [event.operation, event.phase])).toEqual([['put', 'entering'], ['put', 'threw']]);
    hook.restore();
  });

  it('rethrows the identical end callback exception and records nested finalized failure', () => {
    const failure = new Error('Synthetic callback failure');
    const streamer = new runtime.TextStreamer({ all_special_ids: [], decode: () => 'remaining' } as never, { skip_prompt: true, callback_function: () => {
      throw failure;
    } });
    streamer.put([[1n]]);
    streamer.put([[2n]]);
    const capture = recorder();
    const hook = observeNativeStreamer({ streamer, streamerPrototype: runtime.TextStreamer.prototype, capture });
    let thrown: unknown;
    try {
      streamer.end();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(capture.recordNativeStream.mock.calls.map(([event]) => [event.operation, event.phase])).toEqual([['end', 'entering'], ['on_finalized_text', 'entering'], ['on_finalized_text', 'threw'], ['end', 'threw']]);
    hook.restore();
  });

  it('returns a foreign thenable unchanged without reading then or adding an acknowledgement', () => {
    const then = vi.fn(() => {
      throw new Error('Do not inspect then');
    });
    const returned = Object.defineProperty({}, 'then', { get: then });
    class Streamer {
      put() {
        return returned;
      } end() {} on_finalized_text() {}
    }
    const streamer = new Streamer(); const capture = recorder();
    const hook = observeNativeStreamer({ streamer, streamerPrototype: Streamer.prototype, capture });
    expect(streamer.put()).toBe(returned);
    expect(then).not.toHaveBeenCalled();
    expect(capture.recordNativeStream).toHaveBeenCalledTimes(2);
    hook.restore();
  });

  it('restores all three original inherited descriptors and reports restoration once', () => {
    const fixture = syntheticStreamer(); const capture = recorder();
    const descriptors = Object.getOwnPropertyDescriptors(fixture.prototype);
    const hook = observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture });
    expect(Object.hasOwn(fixture.streamer, 'put')).toBe(true);
    hook.restore(); hook.restore();
    expect(Object.getOwnPropertyDescriptors(fixture.streamer)).toEqual({});
    expect(Object.getOwnPropertyDescriptors(fixture.prototype)).toEqual(descriptors);
    expect(capture.setNativeStreamAvailability.mock.calls.map(([value]) => value.availability)).toEqual([{ status: 'available', restoration: 'pending' }, { status: 'available', restoration: 'restored' }]);
  });

  it('does not evaluate an accessor-valued method or replace it', () => {
    const fixture = syntheticStreamer(); const capture = recorder();
    const getter = vi.fn(() => {
      throw new Error('Do not evaluate getter');
    });
    Object.defineProperty(fixture.streamer, 'put', { configurable: true, get: getter });
    const before = Object.getOwnPropertyDescriptors(fixture.streamer);
    observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture }).restore();
    expect(getter).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptors(fixture.streamer)).toEqual(before);
    expect(capture.setNativeStreamAvailability).toHaveBeenCalledWith({ availability: { status: 'unavailable', reason: 'method-descriptor' } });
  });

  it('does not steal an existing instance owner and lets that owner restore its methods', () => {
    const fixture = syntheticStreamer(); const first = recorder(); const second = recorder();
    const owner = observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture: first });
    const methods = Object.getOwnPropertyDescriptors(fixture.streamer);
    observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture: second }).restore();
    expect(Object.getOwnPropertyDescriptors(fixture.streamer)).toEqual(methods);
    fixture.streamer.put([[1n]]);
    expect(first.recordNativeStream).toHaveBeenCalledTimes(2);
    expect(second.recordNativeStream).not.toHaveBeenCalled();
    expect(second.setNativeStreamAvailability).toHaveBeenCalledWith({ availability: { status: 'unavailable', reason: 'already-owned' } });
    owner.restore();
  });

  it('reports a non-extensible instance unavailable without changing its methods', () => {
    const fixture = syntheticStreamer(); const capture = recorder();
    Object.preventExtensions(fixture.streamer);
    observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture }).restore();
    expect(fixture.streamer.put()).toBe(fixture.returned);
    expect(capture.setNativeStreamAvailability).toHaveBeenCalledWith({ availability: { status: 'unavailable', reason: 'not-extensible' } });
  });

  it('performs no descriptor or prototype access when capture is undefined', () => {
    const trap = vi.fn(() => {
      throw new Error('No capture inspection');
    });
    const streamer = new Proxy({}, { getPrototypeOf: trap, getOwnPropertyDescriptor: trap, defineProperty: trap });
    expect(() => observeNativeStreamer({ streamer, streamerPrototype: {}, capture: undefined }).restore()).not.toThrow();
    expect(trap).not.toHaveBeenCalled();
  });

  it('contains recording failures without changing the original invocation', () => {
    const fixture = syntheticStreamer(); const capture = recorder();
    capture.recordNativeStream.mockImplementation(() => {
      throw new Error('Recorder failed');
    });
    capture.setNativeStreamAvailability.mockImplementation(() => {
      throw new Error('Recorder failed');
    });
    const hook = observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture });
    expect(fixture.streamer.put([[1n]])).toBe(fixture.returned);
    expect(fixture.calls).toHaveLength(1);
    expect(() => hook.restore()).not.toThrow();
    expect(Object.hasOwn(fixture.streamer, 'put')).toBe(false);
  });

  it('does not delete a replacement method installed by another owner during restoration', () => {
    const fixture = syntheticStreamer(); const capture = recorder();
    const hook = observeNativeStreamer({ streamer: fixture.streamer, streamerPrototype: fixture.prototype, capture });
    const replacement = vi.fn();
    Object.defineProperty(fixture.streamer, 'put', { configurable: true, value: replacement });
    hook.restore();
    expect(fixture.streamer.put).toBe(replacement);
    expect(capture.setNativeStreamAvailability).toHaveBeenLastCalledWith({ availability: { status: 'available', restoration: 'ownership-lost' } });
  });

  it('rolls back a partial installation without leaving earlier method hooks behind', () => {
    const fixture = syntheticStreamer(); const capture = recorder();
    const streamer = new Proxy(fixture.streamer, { defineProperty(target, key, descriptor) {
      if (key === 'on_finalized_text') throw new Error('Synthetic install failure');
      return Reflect.defineProperty(target, key, descriptor);
    } });
    observeNativeStreamer({ streamer, streamerPrototype: fixture.prototype, capture }).restore();
    expect(Object.getOwnPropertyDescriptors(fixture.streamer)).toEqual({});
    expect(capture.setNativeStreamAvailability).toHaveBeenCalledWith({ availability: { status: 'unavailable', reason: 'install-failed' } });
  });

  it('contains restoration failure and reports it without throwing over a native result', () => {
    const fixture = syntheticStreamer(); const capture = recorder();
    const streamer = new Proxy(fixture.streamer, { deleteProperty() {
      return false;
    } });
    const hook = observeNativeStreamer({ streamer, streamerPrototype: fixture.prototype, capture });
    expect(streamer.put()).toBe(fixture.returned);
    expect(() => hook.restore()).not.toThrow();
    expect(capture.setNativeStreamAvailability).toHaveBeenLastCalledWith({ availability: { status: 'available', restoration: 'failed' } });
  });
});
