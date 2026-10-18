import { describe, expect, it, vi } from 'vitest';
import { encodeChatPrompt, tokenizeChatPrompt } from './tokenize-chat-prompt';
import type { ChatPromptPart } from '@/features/llama-cpp-browser/runtime/chat-bindings';

function fixture({ parts }: { parts: ChatPromptPart[] }) {
  const encoded = encodeChatPrompt({ parts });
  const memory = new Uint8Array(8 * 1024 * 1024);
  const prompt = 16n;
  memory.set(encoded.data, Number(prompt));
  let next = Math.ceil((encoded.data.length + 64) / 16) * 16;
  const allocations = new Map<bigint, number>();
  const policy = { bos: true, eos: false, sep: false };
  const tryAlloc = vi.fn(({ bytes }: { bytes: number | bigint }): bigint | undefined => {
    const length = Number(bytes);
    const pointer = BigInt(next);
    next += length + 16;
    allocations.set(pointer, length);
    return pointer;
  });
  const core = {
    tryAlloc,
    alloc: ({ bytes }: { bytes: number | bigint }) => {
      const pointer = tryAlloc({ bytes });
      if (pointer === undefined) {
        throw new Error('allocation failed');
      }
      return pointer;
    },
    free: vi.fn(({ pointer }: { pointer: bigint }) => {
      if (!allocations.delete(pointer)) {
        throw new Error('Unowned or repeated free');
      }
    }),
    bytes: vi.fn(({ pointer, length }: { pointer: bigint, length: number | bigint }) => {
      const capacity = allocations.get(pointer);
      if (capacity === undefined || capacity < Number(length)) {
        throw new RangeError('Invalid native token span');
      }
      return memory.subarray(Number(pointer), Number(pointer) + Number(length));
    }),
    api: {
      llama_vocab_get_add_bos: vi.fn(async () => Number(policy.bos)),
      llama_vocab_get_add_eos: vi.fn(async () => Number(policy.eos)),
      llama_vocab_get_add_sep: vi.fn(async () => Number(policy.sep)),
      llama_vocab_bos: vi.fn(async () => 1),
      llama_vocab_eos: vi.fn(async () => 2),
      llama_vocab_sep: vi.fn(async () => 3),
      llama_tokenize: vi.fn(async (_vocab: bigint, source: bigint, length: number, destination: bigint, capacity: number, addSpecial: number, parseSpecial: number) => {
        const text = new TextDecoder().decode(memory.subarray(Number(source), Number(source) + length));
        const tokens: number[] = [];
        if (addSpecial && policy.bos) {
          tokens.push(1);
        }
        for (const part of text.split(/(<s>|<\/s>)/u)) {
          if (parseSpecial && part === '<s>') {
            tokens.push(1);
          } else if (parseSpecial && part === '</s>') {
            tokens.push(2);
          } else {
            tokens.push(...Array.from(new TextEncoder().encode(part), byte => byte + 10));
          }
        }
        if (addSpecial && policy.eos) {
          tokens.push(2);
        }
        if (addSpecial && policy.sep) {
          tokens.push(3);
        }
        if (tokens.length > capacity) {
          return -tokens.length;
        }
        if (destination !== 0n) {
          const view = new DataView(memory.buffer, Number(destination), capacity * 4);
          tokens.forEach((token, index) => view.setInt32(index * 4, token, true));
        }
        return tokens.length;
      }),
    },
  };
  const onTokenize = vi.fn();
  return {
    core,
    prompt,
    encoded,
    allocations,
    policy,
    onTokenize,
    run({ contextTokens }: { contextTokens: number }) {
      return tokenizeChatPrompt({ core, vocab: 1n, prompt, parts: encoded.parts, contextTokens, onTokenize });
    },
    [Symbol.dispose]() {
      for (const pointer of allocations.keys()) {
        core.free({ pointer });
      }
    },
  };
}

const parts: ChatPromptPart[] = [
  { text: '<s>', isInput: false },
  { text: '<s>日本語\0😀</s>', isInput: true },
  { text: '</s>', isInput: false },
];

describe('segmented native chat prompt tokenization', () => {
  it('preserves Unicode, embedded NUL and byte boundaries while encoding each part once', () => {
    using encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const result = encodeChatPrompt({ parts });
    expect(encode.mock.calls).toEqual(parts.map(part => [part.text]));
    expect(new TextDecoder().decode(result.data)).toBe(parts.map(part => part.text).join(''));
    expect(result.parts).toEqual([
      { byteOffset: 0, byteLength: 3, isInput: false },
      { byteOffset: 3, byteLength: 21, isInput: true },
      { byteOffset: 24, byteLength: 4, isInput: false },
    ]);
  });

  it('recognizes template markers but keeps identical user text as ordinary tokens', async () => {
    using f = fixture({ parts });
    const result = await f.run({ contextTokens: 100 });
    expect(result.tokens).toEqual([1, 1, ...Array.from(new TextEncoder().encode(parts[1]!.text), byte => byte + 10), 2]);
    expect(result.parts.map(part => [part.tokenOffset, part.tokenCount, part.addSpecial])).toEqual([[1, 1, false], [2, 21, false], [23, 1, false]]);
    expect(f.core.api.llama_tokenize.mock.calls.map(call => [call[1], call[2], call[5], call[6]])).toEqual([
      [16n, 3, 0, 1], [19n, 21, 0, 0], [40n, 4, 0, 1],
    ]);
    expect(f.onTokenize).toHaveBeenCalledTimes(3);
    expect([...f.allocations.keys()]).toEqual([result.pointer]);
    const bytes = f.core.bytes({ pointer: result.pointer, length: result.tokens.length * 4 });
    expect(Array.from(new Int32Array(bytes.buffer, bytes.byteOffset, result.tokens.length))).toEqual(result.tokens);
  });

  it.each([false, true])('keeps the one-call fast path with input marking %s', async isInput => {
    using f = fixture({ parts: [{ text: '<s>', isInput }] });
    const result = await f.run({ contextTokens: 32 });
    expect(result.tokens).toEqual(isInput ? [1, 70, 125, 72] : [1, 1]);
    expect(f.core.api.llama_tokenize).toHaveBeenCalledOnce();
    expect(f.core.api.llama_tokenize.mock.calls[0]?.slice(5)).toEqual([1, Number(!isInput)]);
    expect(f.core.api.llama_vocab_get_add_bos).not.toHaveBeenCalled();
  });

  it('places automatic ending and separator tokens after all prompt parts', async () => {
    using f = fixture({ parts });
    f.policy.eos = true;
    f.policy.sep = true;
    const result = await f.run({ contextTokens: 100 });
    expect(result.tokens.slice(-3)).toEqual([2, 2, 3]);
    expect(result.tokens.filter(token => token === 3)).toHaveLength(1);
    expect(result.tokens.filter(token => token === 1)).toHaveLength(2);
  });

  it('reserves context for automatic ending tokens and one generated token', async () => {
    using f = fixture({ parts: [{ text: 'a', isInput: true }, { text: 'b', isInput: false }] });
    f.policy.eos = true;
    await expect(f.run({ contextTokens: 4 })).rejects.toThrow('context-full');
    expect(f.allocations.size).toBe(0);
    const result = await f.run({ contextTokens: 5 });
    expect(result.tokens).toEqual([1, 107, 108, 2]);
  });

  it('rejects invalid native automatic token IDs without allocating a buffer', async () => {
    using f = fixture({ parts });
    f.core.api.llama_vocab_bos.mockResolvedValue(-1);
    await expect(f.run({ contextTokens: 100 })).rejects.toThrow('runtime-error');
    expect(f.core.tryAlloc).not.toHaveBeenCalled();
    expect(f.core.api.llama_tokenize).not.toHaveBeenCalled();
  });

  it('handles an empty native part without treating the whole prompt as empty', async () => {
    using f = fixture({ parts: [{ text: ' ', isInput: true }, { text: 'a', isInput: false }] });
    f.core.api.llama_tokenize.mockResolvedValueOnce(0);
    const result = await f.run({ contextTokens: 3 });
    expect(result.tokens).toEqual([1, 107]);
    expect(result.parts[0]?.tokenCount).toBe(0);
    expect(f.allocations.size).toBe(1);
  });

  it('waits for a suspended native failure before releasing its segment buffer', async () => {
    using f = fixture({ parts });
    const native = Promise.withResolvers<number>();
    f.core.api.llama_tokenize.mockReturnValueOnce(native.promise);
    const pending = f.run({ contextTokens: 100 });
    const failure = new WebAssembly.RuntimeError('native tokenizer trap');
    const rejected = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(f.core.api.llama_tokenize).toHaveBeenCalledOnce());
    expect(f.allocations.size).toBe(1);
    expect(f.core.free).not.toHaveBeenCalled();
    native.reject(failure);
    await rejected;
    expect(f.allocations.size).toBe(0);
    expect(f.core.free).toHaveBeenCalledOnce();
  });

  it('releases earlier and failing segment buffers when a later native call rejects', async () => {
    using f = fixture({ parts });
    f.core.api.llama_tokenize.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('second segment'));
    await expect(f.run({ contextTokens: 100 })).rejects.toThrow('second segment');
    expect(f.allocations.size).toBe(0);
    expect(f.core.free).toHaveBeenCalledTimes(2);
  });

  it('releases the final buffer if copying the assembled tokens fails', async () => {
    using f = fixture({ parts });
    const read = f.core.bytes.getMockImplementation()!;
    f.core.bytes.mockImplementation(args => {
      if (f.core.api.llama_tokenize.mock.calls.length === 3 && f.allocations.size === 1 && args.length === 24 * 4) {
        throw new RangeError('assembly failed');
      }
      return read(args);
    });
    await expect(f.run({ contextTokens: 100 })).rejects.toThrow('assembly failed');
    expect(f.allocations.size).toBe(0);
  });

  it('rejects discontinuous byte spans before calling native code', async () => {
    using f = fixture({ parts });
    await expect(tokenizeChatPrompt({ core: f.core, vocab: 1n, prompt: f.prompt, parts: [{ byteOffset: 1, byteLength: 3, isInput: false }], contextTokens: 32, onTokenize: f.onTokenize })).rejects.toThrow('runtime-error');
    expect(f.core.api.llama_tokenize).not.toHaveBeenCalled();
  });

  it('enforces the byte limit across multiple parts rather than individually', () => {
    expect(() => encodeChatPrompt({ parts: [{ text: 'a'.repeat(4 * 1024 * 1024), isInput: false }, { text: 'x', isInput: true }] })).toThrow('context-full');
  });

  it('keeps an empty prompt representable for native automatic tokens', async () => {
    using f = fixture({ parts: [{ text: '', isInput: true }] });
    const result = await f.run({ contextTokens: 2 });
    expect(result.tokens).toEqual([1]);
    expect(f.core.api.llama_tokenize).toHaveBeenCalledOnce();
  });
});
