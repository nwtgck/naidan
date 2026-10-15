import { describe, expect, it, vi } from 'vitest';
import type { Core } from './core';
import { fileBackedRowsCapability } from './file-backed-rows';

function fixture({ version, query, pointerBytes }: { version: unknown, query: unknown, pointerBytes: 4 | 8 }) {
  return { module: { _lcb_file_backed_rows_version: version, _lcb_model_file_backed_shard: query }, pointerBytes, assertIdle: vi.fn() } as unknown as Core;
}

describe('file-backed rows runtime negotiation', () => {
  it.each([undefined, () => 0])('keeps older or explicitly disabled runtimes eager', version => {
    const query = vi.fn();
    const core = fixture({ version, query, pointerBytes: 4 });
    expect(fileBackedRowsCapability({ core })).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(core.assertIdle).toHaveBeenCalledOnce();
  });

  it.each([1, '1', () => 2, () => '1', () => undefined, () => Promise.resolve(1)])('rejects malformed or unknown versions', version => {
    expect(() => fileBackedRowsCapability({ core: fixture({ version, query: () => 0, pointerBytes: 8 }) })).toThrow('runtime-error');
  });

  it('rejects mismatched pointer width and incomplete implementations', () => {
    expect(() => fileBackedRowsCapability({ core: fixture({ version: () => 1, query: () => 0, pointerBytes: 4 }) })).toThrow('runtime-error');
    expect(() => fileBackedRowsCapability({ core: fixture({ version: () => 1, query: undefined, pointerBytes: 8 }) })).toThrow('runtime-error');
  });

  it('queries the loaded model with its full-width pointer and exact shard order', () => {
    const query = vi.fn(() => 2);
    const core = fixture({ version: () => 1, query, pointerBytes: 8 });
    const feature = fileBackedRowsCapability({ core });
    expect(feature?.retainedShard({ model: 2n ** 40n + 17n, count: 3 })).toBe(2);
    expect(query).toHaveBeenCalledExactlyOnceWith(2n ** 40n + 17n);
    expect(core.assertIdle).toHaveBeenCalledTimes(2);
  });

  it('accepts an explicitly non-streaming model', () => {
    const feature = fileBackedRowsCapability({ core: fixture({ version: () => 1, query: () => -1, pointerBytes: 8 }) });
    expect(feature?.retainedShard({ model: 10n, count: 3 })).toBeUndefined();
  });

  it.each([-2, 3, 0.5, NaN, Infinity, undefined, '1', 1n, Promise.resolve(1)])('rejects unsafe shard results', index => {
    const feature = fileBackedRowsCapability({ core: fixture({ version: () => 1, query: () => index, pointerBytes: 8 }) });
    expect(() => feature?.retainedShard({ model: 10n, count: 3 })).toThrow('runtime-error');
  });

  it('never queries a null model, invalid shard count or busy runtime', () => {
    const query = vi.fn(() => 1);
    const core = fixture({ version: () => 1, query, pointerBytes: 8 });
    const feature = fileBackedRowsCapability({ core });
    expect(() => feature?.retainedShard({ model: 0n, count: 3 })).toThrow('runtime-error');
    expect(() => feature?.retainedShard({ model: 10n, count: 0 })).toThrow('runtime-error');
    vi.mocked(core.assertIdle).mockImplementation(() => {
      throw new Error('busy');
    });
    expect(() => feature?.retainedShard({ model: 10n, count: 3 })).toThrow('busy');
    expect(query).not.toHaveBeenCalled();
  });
});
