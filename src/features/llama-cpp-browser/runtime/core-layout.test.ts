// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attachCore, createCore, type Core, type CoreModule } from './core';

describe('module-local native ABI layouts', () => {
  let core: Core;
  beforeAll(async () => {
    const baseURL = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles') + '/');
    core = await createCore({
      profile: 'cpu-wasm32',
      baseURL,
      moduleOptions: {
        wasmBinary: await readFile(new URL('cpu-wasm32/browser/core.wasm', baseURL)),
        print() {},
        printErr() {},
      },
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function instrument({ overrides }: { overrides: Record<string, unknown> }) {
    const counts = new Map<string, number>();
    const module: CoreModule = new Proxy(core.module, {
      get(target, property) {
        if (typeof property === 'string' && Object.hasOwn(overrides, property)) return overrides[property];
        const value: unknown = Reflect.get(target, property, target);
        if (typeof property === 'string' && ['_lcb_sizeof_record', '_lcb_offsetof_field', '_lcb_sizeof_field'].includes(property)) {
          if (typeof value !== 'function') throw new Error('Missing fixture native layout export');
          // Instrument native scalar ABI without changing the call shape.
          return (...args: (number | bigint)[]) => {
            counts.set(property, (counts.get(property) ?? 0) + 1);
            return Reflect.apply(value, target, args);
          };
        }
        return value;
      },
    });
    return { module, counts };
  }
  it('queries each used layout once but writes each actual record and value', () => {
    const { module, counts } = instrument({ overrides: {} });
    const bound = attachCore({ module, callMode: 'direct' });
    const a = bound.allocRecord({ name: 'llama_batch' });
    const b = bound.allocRecord({ name: 'llama_batch' });
    try {
      for (let i = 0; i < 100; i++) bound.setField({ name: 'llama_batch', field: 'n_tokens', pointer: a, value: i });
      bound.setField({ name: 'llama_batch', field: 'n_tokens', pointer: b, value: 12 });
      const layout = bound.fieldLayout({ name: 'llama_batch', field: 'n_tokens' });
      const read = ({ pointer }: { pointer: bigint }) => {
        const span = bound.bytes({ pointer: pointer + layout.offset, length: layout.size });
        return new DataView(span.buffer, span.byteOffset, span.byteLength).getInt32(0, true);
      };
      expect(read({ pointer: a })).toBe(99); expect(read({ pointer: b })).toBe(12);
      expect(counts.get('_lcb_sizeof_record')).toBe(1);
      expect(counts.get('_lcb_offsetof_field')).toBe(1);
      expect(counts.get('_lcb_sizeof_field')).toBe(1);
      expect(bound.fieldLayout({ name: 'llama_batch', field: 'token' })).not.toBe(layout);
      expect(counts.get('_lcb_offsetof_field')).toBe(2);
      expect(counts.get('_lcb_sizeof_field')).toBe(2);
      expect(Object.isFrozen(layout)).toBe(true);
      expect(Reflect.set(layout, 'size', 1)).toBe(false);
      expect(bound.fieldLayout({ name: 'llama_batch', field: 'n_tokens' }).size).toBe(4);
    } finally {
      bound.free({ pointer: a }); bound.free({ pointer: b });
    }
  });
  it('reads the current heap after replacement, without caching a DataView or tensor address', () => {
    let heap = core.module.HEAPU8;
    const { module: source } = instrument({ overrides: {} });
    const module = new Proxy(source, {
      get(target, property) {
        return property === 'HEAPU8' ? heap : Reflect.get(target, property, target);
      },
    });
    const bound = attachCore({ module, callMode: 'direct' });
    const pointer = bound.allocRecord({ name: 'llama_batch' });
    const layout = bound.fieldLayout({ name: 'llama_batch', field: 'n_tokens' });
    const at = Number(pointer + layout.offset);
    try {
      bound.setField({ name: 'llama_batch', field: 'n_tokens', pointer, value: 1 });
      const previous = heap;
      heap = new Uint8Array(previous.length); heap.set(previous);
      bound.setField({ name: 'llama_batch', field: 'n_tokens', pointer, value: 73 });
      expect(new DataView(heap.buffer).getInt32(at, true)).toBe(73);
      expect(new DataView(previous.buffer).getInt32(at, true)).toBe(1);
      heap = new Uint8Array(at + 3);
      expect(() => bound.setField({ name: 'llama_batch', field: 'n_tokens', pointer, value: 1 })).toThrow('out of bounds');
    } finally {
      bound.free({ pointer });
    }
  });
  it('does not share layouts between module attachments or pointer widths', () => {
    const { module, counts } = instrument({ overrides: {} });
    const first = attachCore({ module, callMode: 'direct' });
    const layout = first.fieldLayout({ name: 'llama_batch', field: 'token' });
    const second = attachCore({ module, callMode: 'direct' });
    expect(second.fieldLayout({ name: 'llama_batch', field: 'token' })).toEqual(layout);
    expect(counts.get('_lcb_offsetof_field')).toBe(2);
    // Synthetic metadata only; this does not execute a wasm64 runtime.
    const { module: wideModule } = instrument({
      overrides: {
        _lcb_pointer_bytes: () => 8,
        _lcb_offsetof_field: () => layout.offset + 8n,
        _lcb_sizeof_field: () => 8,
        _lcb_sizeof_record: () => 128,
      },
    });
    const wide = attachCore({ module: wideModule, callMode: 'direct' });
    expect(wide.fieldLayout({ name: 'llama_batch', field: 'token' })).toEqual({ kind: 'pointer', offset: layout.offset + 8n, size: 8 });
    expect(wide.recordSize({ name: 'llama_batch' })).toBe(128);
    expect(first.fieldLayout({ name: 'llama_batch', field: 'token' })).toBe(layout);
  });
  it.each(['direct', 'asyncify'] as const)('checks serialization even on warm layout hits in %s mode', async callMode => {
    const gate = Promise.withResolvers<bigint>();
    const { module } = instrument({
      overrides: {
        _lcb_ggml_backend_dev_count: () => gate.promise,
        ccall: () => gate.promise,
      },
    });
    const bound = attachCore({ module, callMode });
    bound.recordSize({ name: 'llama_batch' });
    bound.fieldLayout({ name: 'llama_batch', field: 'token' });
    const pointer = bound.allocRecord({ name: 'llama_batch' });
    const pending = bound.api.ggml_backend_dev_count();
    try {
      for (const action of [
        () => bound.recordSize({ name: 'llama_batch' }),
        () => bound.recordSize({ name: 'llama_context_params' }),
        () => bound.fieldLayout({ name: 'llama_batch', field: 'token' }),
        () => bound.fieldLayout({ name: 'llama_batch', field: 'n_tokens' }),
        () => bound.setField({ name: 'llama_batch', field: 'token', pointer, value: 0n }),
      ]) expect(action).toThrow('Serialize access');
    } finally {
      gate.resolve(0n); await pending; bound.free({ pointer });
    }
    expect(bound.fieldLayout({ name: 'llama_batch', field: 'token' }).kind).toBe('pointer');
  });
  it.each(['_lcb_sizeof_field', '_lcb_offsetof_field', '_lcb_sizeof_record'])('does not memoize a failed %s query', exportName => {
    const original = Reflect.get(core.module, exportName);
    if (typeof original !== 'function') throw new Error('Missing native export');
    const failure = new WebAssembly.RuntimeError('layout query failed');
    const stub = vi.fn().mockImplementationOnce(() => {
      throw failure;
    }).mockImplementation((...args: (number | bigint)[]) => Reflect.apply(original, core.module, args));
    const { module } = instrument({ overrides: { [exportName]: stub } });
    const bound = attachCore({ module, callMode: 'direct' });
    const read = () => exportName === '_lcb_sizeof_record' ? bound.recordSize({ name: 'llama_batch' }) : bound.fieldLayout({ name: 'llama_batch', field: 'token' });
    expect(read).toThrow(failure);
    const valid = read(); expect(read()).toEqual(valid); expect(stub).toHaveBeenCalledTimes(2);
  });
  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe offsets or sizes before caching: %s', invalid => {
    for (const exportName of ['_lcb_sizeof_field', '_lcb_offsetof_field', '_lcb_sizeof_record']) {
      const original = Reflect.get(core.module, exportName);
      if (typeof original !== 'function') throw new Error('Missing native export');
      const stub = vi.fn().mockReturnValueOnce(invalid).mockImplementation((...args: (number | bigint)[]) => Reflect.apply(original, core.module, args));
      const { module } = instrument({ overrides: { [exportName]: stub } });
      const bound = attachCore({ module, callMode: 'direct' });
      const read = () => exportName === '_lcb_sizeof_record' ? bound.recordSize({ name: 'llama_batch' }) : bound.fieldLayout({ name: 'llama_batch', field: 'token' });
      expect(read).toThrow('Unsafe memory index'); expect(read).not.toThrow(); expect(stub).toHaveBeenCalledTimes(2);
    }
  });
  it('rejects unknown schema names and still validates each write on cache hits', () => {
    const { module, counts } = instrument({ overrides: {} });
    const bound = attachCore({ module, callMode: 'direct' });
    for (const name of ['missing', '__proto__', 'constructor']) {
      expect(() => bound.recordSize({ name })).toThrow('Unknown native record');
      expect(() => bound.fieldLayout({ name, field: 'n_tokens' })).toThrow('Unknown native record');
      expect(() => bound.fieldLayout({ name: 'llama_batch', field: name })).toThrow('Unknown native field');
    }
    expect(counts.size).toBe(0);
    const pointer = bound.allocRecord({ name: 'llama_batch' });
    try {
      bound.setField({ name: 'llama_batch', field: 'n_tokens', pointer, value: 7 });
      for (const value of [0.5, NaN, Infinity, 2147483648, -2147483649]) {
        expect(() => bound.setField({ name: 'llama_batch', field: 'n_tokens', pointer, value })).toThrow();
      }
      bound.setField({ name: 'llama_batch', field: 'token', pointer, value: 0n });
      expect(() => bound.setField({ name: 'llama_batch', field: 'token', pointer, value: 1n << 32n })).toThrow('overflow');
      expect(() => bound.setField({ name: 'llama_batch', field: 'token', pointer: BigInt(module.HEAPU8.length), value: 0n })).toThrow('out of bounds');
    } finally {
      bound.free({ pointer });
    }
  });
});
