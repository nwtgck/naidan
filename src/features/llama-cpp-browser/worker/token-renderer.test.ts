// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createTokenRenderer, TEST_ONLY } from './token-renderer';

function fixture({ cacheMode }: { cacheMode: 'bounded' | 'disabled' }) {
  let pointer = 10n;
  const allocations = new Map<bigint, Uint8Array>();
  const pieces = new Map<number, Uint8Array>();
  const core = {
    alloc: vi.fn(({ bytes }: { bytes: number | bigint }) => {
      const result = pointer++;
      allocations.set(result, new Uint8Array(Number(bytes)));
      return result;
    }),
    free: vi.fn(({ pointer }: { pointer: bigint }) => {
      if (!allocations.delete(pointer)) throw new Error('Double or unowned free');
    }),
    bytes: vi.fn(({ pointer, length }: { pointer: bigint, length: number | bigint }) => {
      const bytes = allocations.get(pointer);
      if (!bytes || bytes.length < Number(length)) throw new RangeError('Invalid view');
      return bytes.subarray(0, Number(length));
    }),
    api: {
      llama_vocab_is_eog: vi.fn(async (_vocab: bigint, token: number): Promise<number> => token === 0 ? 1 : 0),
      llama_token_to_piece: vi.fn(async (_vocab: bigint, token: number, pointer: bigint, length: number, _lstrip: number, special: number): Promise<number> => {
        const bytes = pieces.get(token) ?? new TextEncoder().encode(special ? `<${token}>` : String(token));
        if (length < bytes.length) return -bytes.length;
        allocations.get(pointer)!.set(bytes);
        return bytes.length;
      }),
    },
  };
  return { core, pieces, allocations, renderer: createTokenRenderer({ core, vocab: 5n, cacheMode }) };
}

describe('bounded request-local token rendering', () => {
  it('does not allocate or call native code before the first token', () => {
    const { core, renderer } = fixture({ cacheMode: 'bounded' });
    expect(core.alloc).not.toHaveBeenCalled();
    expect(renderer.finish()).toBe('');
    renderer.dispose(); renderer.dispose();
    expect(core.free).not.toHaveBeenCalled();
  });
  it('reuses both native results but still returns text on every hit', async () => {
    const { core, renderer, allocations } = fixture({ cacheMode: 'bounded' });
    for (let i = 0; i < 100; i++) expect(await renderer.render({ token: 17, special: false })).toEqual({ text: '17', endOfGeneration: false });
    expect(core.api.llama_vocab_is_eog).toHaveBeenCalledOnce();
    expect(core.api.llama_token_to_piece).toHaveBeenCalledExactlyOnceWith(5n, 17, 10n, 256, 0, 0);
    expect(renderer.counters).toMatchObject({ cacheHits: 99, cacheMisses: 1, eogCalls: 1, pieceCalls: 1, peakEntries: 1, peakCachedBytes: 2 });
    renderer.dispose(); renderer.dispose();
    expect(allocations.size).toBe(0); expect(core.free).toHaveBeenCalledOnce();
  });
  it('includes the special-token visibility flag in the key', async () => {
    const { renderer, core } = fixture({ cacheMode: 'bounded' });
    for (let i = 0; i < 3; i++) {
      expect((await renderer.render({ token: 99, special: false })).text).toBe('99');
      expect((await renderer.render({ token: 99, special: true })).text).toBe('<99>');
    }
    expect(core.api.llama_token_to_piece).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });
  it('supports the full nonnegative int32 range without cache-key collisions', async () => {
    const { renderer } = fixture({ cacheMode: 'bounded' });
    for (const token of [0, 1073741824, 2147483647]) {
      for (const special of [false, true]) await renderer.render({ token, special });
    }
    expect(renderer.counters.peakEntries).toBe(6);
    expect(await renderer.render({ token: 0, special: false })).toEqual({ text: '0', endOfGeneration: true });
    expect((await renderer.render({ token: 2147483647, special: true })).text).toBe('<2147483647>');
    renderer.dispose();
  });
  it('does not keep views into a reused or replaced Wasm heap', async () => {
    const { renderer, pieces, allocations } = fixture({ cacheMode: 'bounded' });
    pieces.set(1, Uint8Array.of(65)); pieces.set(2, Uint8Array.of(66));
    expect((await renderer.render({ token: 1, special: false })).text).toBe('A');
    expect((await renderer.render({ token: 2, special: false })).text).toBe('B');
    for (const [pointer, bytes] of allocations) {
      bytes.fill(88); allocations.set(pointer, new Uint8Array(bytes.length));
    }
    expect((await renderer.render({ token: 1, special: false })).text).toBe('A');
    renderer.dispose();
  });
  it('decodes cached byte fragments in order instead of caching partial strings', async () => {
    const { renderer, pieces, core } = fixture({ cacheMode: 'bounded' });
    [0xe6, 0x97, 0xa5].forEach((byte, i) => pieces.set(i + 1, Uint8Array.of(byte)));
    const chunks: string[] = [];
    for (const token of [1, 2, 3, 1, 2, 3]) chunks.push((await renderer.render({ token, special: false })).text);
    expect(chunks).toEqual(['', '', '日', '', '', '日']);
    expect(renderer.finish()).toBe('');
    expect(core.api.llama_token_to_piece).toHaveBeenCalledTimes(3);
    renderer.dispose();
  });
  it('keeps stream state through empty pieces and flushes an incomplete character once', async () => {
    const { renderer, pieces } = fixture({ cacheMode: 'bounded' });
    pieces.set(1, Uint8Array.of(0xe6)); pieces.set(2, new Uint8Array());
    await renderer.render({ token: 2, special: false });
    expect((await renderer.render({ token: 1, special: false })).text).toBe('');
    expect((await renderer.render({ token: 2, special: false })).text).toBe('');
    expect(renderer.finish()).toBe('\uFFFD'); expect(renderer.finish()).toBe('');
    renderer.dispose();
  });
  it.each([[0xef, 0xbb, 0xbf, 65], [0xff, 65, 0xc3, 0xa9], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x90, 0x88]].map(bytes => ({ bytes })))('matches an uncached decoder for byte sequence $bytes', async ({ bytes }) => {
    const a = fixture({ cacheMode: 'bounded' }); const b = fixture({ cacheMode: 'disabled' });
    bytes.forEach((byte, i) => {
      a.pieces.set(i, Uint8Array.of(byte)); b.pieces.set(i, Uint8Array.of(byte));
    });
    for (let repeat = 0; repeat < 3; repeat++) {
      for (let token = 0; token < bytes.length; token++) {
        expect(await a.renderer.render({ token, special: false })).toEqual(await b.renderer.render({ token, special: false }));
      }
    }
    expect(a.renderer.finish()).toBe(b.renderer.finish());
    a.renderer.dispose(); b.renderer.dispose();
  });
  it('reacquires the memory view after an asynchronous native call grows memory', async () => {
    const { renderer, core, allocations } = fixture({ cacheMode: 'bounded' });
    core.api.llama_token_to_piece.mockImplementationOnce(async (_vocab, _token, pointer) => {
      const bytes = new Uint8Array(1024); bytes.set([71]); allocations.set(pointer, bytes); return 1;
    });
    expect((await renderer.render({ token: 1, special: false })).text).toBe('G');
    expect((await renderer.render({ token: 1, special: false })).text).toBe('G');
    renderer.dispose();
  });
  it('grows only once and frees the obsolete scratch buffer before replacement', async () => {
    const { renderer, pieces, core, allocations } = fixture({ cacheMode: 'bounded' });
    pieces.set(1, new Uint8Array(513).fill(65));
    expect((await renderer.render({ token: 1, special: false })).text).toBe('A'.repeat(513));
    expect(core.api.llama_token_to_piece).toHaveBeenCalledTimes(2);
    expect(core.free.mock.invocationCallOrder[0]).toBeLessThan(core.alloc.mock.invocationCallOrder[1]!);
    expect(allocations.size).toBe(1);
    renderer.dispose(); expect(allocations.size).toBe(0);
  });
  it('keeps large valid pieces uncached without changing their output', async () => {
    const { renderer, pieces } = fixture({ cacheMode: 'bounded' });
    const length = TEST_ONLY.maximumCachedPieceBytes + 1;
    pieces.set(1, new Uint8Array(length).fill(65));
    for (let i = 0; i < 2; i++) expect((await renderer.render({ token: 1, special: false })).text.length).toBe(length);
    expect(renderer.counters).toMatchObject({ peakEntries: 0, peakCachedBytes: 0, oversizedPieces: 2, cacheMisses: 2, pieceCalls: 3 });
    renderer.dispose();
  });
  it('bounds entries, including zero-length entries, and refreshes recent hits', async () => {
    const { renderer, pieces } = fixture({ cacheMode: 'bounded' });
    for (let token = 0; token < TEST_ONLY.maximumEntries; token++) {
      pieces.set(token, new Uint8Array()); await renderer.render({ token, special: false });
    }
    await renderer.render({ token: 0, special: false });
    await renderer.render({ token: TEST_ONLY.maximumEntries, special: false });
    expect(renderer.counters.peakEntries).toBe(TEST_ONLY.maximumEntries);
    const misses = renderer.counters.cacheMisses;
    await renderer.render({ token: 0, special: false });
    expect(renderer.counters.cacheMisses).toBe(misses);
    await renderer.render({ token: 1, special: false });
    expect(renderer.counters.cacheMisses).toBe(misses + 1);
    renderer.dispose();
  });
  it('bounds retained bytes even before the entry limit is reached', async () => {
    const { renderer, pieces } = fixture({ cacheMode: 'bounded' });
    for (let token = 0; token < 40; token++) {
      pieces.set(token, new Uint8Array(TEST_ONLY.maximumCachedPieceBytes).fill(65));
      await renderer.render({ token, special: false });
    }
    expect(renderer.counters.peakCachedBytes).toBe(TEST_ONLY.maximumCachedBytes);
    expect(renderer.counters.peakEntries).toBe(16); expect(renderer.counters.evictions).toBe(24);
    renderer.dispose();
  });
  it('does not share vocabulary results or decoder state across requests', async () => {
    const a = fixture({ cacheMode: 'bounded' }); const b = fixture({ cacheMode: 'bounded' });
    a.pieces.set(1, Uint8Array.of(0xe6)); b.pieces.set(1, Uint8Array.of(65));
    await a.renderer.render({ token: 1, special: false }); a.renderer.dispose();
    expect((await b.renderer.render({ token: 1, special: false })).text).toBe('A');
    expect(b.core.api.llama_token_to_piece).toHaveBeenCalledOnce(); b.renderer.dispose();
  });
  it.each([NaN, Infinity, -1, 1.25, 2147483648])('rejects invalid token %s before a native call', async token => {
    const { renderer, core } = fixture({ cacheMode: 'bounded' });
    await expect(renderer.render({ token, special: false })).rejects.toThrow('runtime-error');
    expect(core.api.llama_vocab_is_eog).not.toHaveBeenCalled(); renderer.dispose();
  });
  it.each([NaN, Infinity, -1, 2, 0.5])('rejects invalid end-of-generation result %s', async end => {
    const { renderer, core } = fixture({ cacheMode: 'bounded' });
    core.api.llama_vocab_is_eog.mockResolvedValueOnce(end);
    await expect(renderer.render({ token: 1, special: false })).rejects.toThrow('runtime-error');
    expect(core.api.llama_token_to_piece).not.toHaveBeenCalled(); renderer.dispose();
  });
  it.each([NaN, Infinity, -Infinity, 0.5, -1, -256, 257, -2147483648, -(1024 * 1024 + 1)])('rejects invalid piece result %s without reading or caching', async length => {
    const { renderer, core, allocations } = fixture({ cacheMode: 'bounded' });
    core.api.llama_token_to_piece.mockResolvedValueOnce(length);
    await expect(renderer.render({ token: 1, special: false })).rejects.toThrow('runtime-error');
    expect(core.bytes).not.toHaveBeenCalled(); expect(renderer.counters.peakEntries).toBe(0);
    renderer.dispose(); expect(allocations.size).toBe(0);
  });
  it.each([-513, 512, 514, NaN])('rejects a changed retry result %s', async length => {
    const { renderer, core, allocations } = fixture({ cacheMode: 'bounded' });
    core.api.llama_token_to_piece.mockResolvedValueOnce(-513).mockResolvedValueOnce(length);
    await expect(renderer.render({ token: 1, special: false })).rejects.toThrow('runtime-error');
    expect(core.api.llama_token_to_piece).toHaveBeenCalledTimes(2);
    expect(renderer.counters.peakEntries).toBe(0);
    renderer.dispose(); expect(allocations.size).toBe(0);
  });
  it('does not double-free after a replacement allocation fails', async () => {
    const { renderer, core, allocations } = fixture({ cacheMode: 'bounded' });
    core.api.llama_token_to_piece.mockResolvedValueOnce(-513);
    core.alloc.mockImplementationOnce(core.alloc.getMockImplementation()!).mockImplementationOnce(() => {
      throw new Error('allocation');
    });
    await expect(renderer.render({ token: 1, special: false })).rejects.toThrow('allocation');
    renderer.dispose(); expect(core.free).toHaveBeenCalledOnce(); expect(allocations.size).toBe(0);
  });
  it.each(['eog', 'piece'] as const)('rejects overlapping access and waits for a pending %s call before freeing', async kind => {
    const { renderer, core, allocations } = fixture({ cacheMode: 'bounded' });
    const pending = Promise.withResolvers<number>();
    switch (kind) {
    case 'eog': core.api.llama_vocab_is_eog.mockReturnValueOnce(pending.promise); break;
    case 'piece': core.api.llama_token_to_piece.mockReturnValueOnce(pending.promise); break;
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    const rendering = renderer.render({ token: 1, special: false });
    const rejected = expect(rendering).rejects.toThrow('trap');
    await Promise.resolve();
    await expect(renderer.render({ token: 2, special: false })).rejects.toThrow('during a native call');
    expect(() => renderer.dispose()).toThrow('during a native call');
    expect(() => renderer.finish()).toThrow('during a native call');
    expect(core.free).not.toHaveBeenCalled();
    pending.reject(new WebAssembly.RuntimeError('trap')); await rejected;
    expect(renderer.counters.peakEntries).toBe(0);
    renderer.dispose(); expect(allocations.size).toBe(0);
  });
  it('does not expose or log cached token IDs or bytes through counters', async () => {
    const { renderer, pieces } = fixture({ cacheMode: 'bounded' });
    pieces.set(1234567, new TextEncoder().encode('private text'));
    await renderer.render({ token: 1234567, special: false });
    const serialized = JSON.stringify(renderer.counters);
    expect(serialized).not.toContain('private'); expect(serialized).not.toContain('1234567');
    renderer.dispose();
    expect(() => renderer.finish()).toThrow('disposed');
    await expect(renderer.render({ token: 1, special: false })).rejects.toThrow('disposed');
  });
});
