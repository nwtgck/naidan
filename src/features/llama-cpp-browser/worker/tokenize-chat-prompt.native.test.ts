// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import createNativeModule from 'llama-cpp-browser-core/profiles/cpu-wasm32/test/core.mjs';
import { attachCore } from '@/features/llama-cpp-browser/runtime/core';
import type { ChatPromptPart } from '@/features/llama-cpp-browser/runtime/chat-bindings';
import { createByteBpeMetadataGguf } from './test-utils/synthetic-gguf.test-support';
import { encodeChatPrompt, tokenizeChatPrompt } from './tokenize-chat-prompt';
import { tokenizePrompt } from './tokenize-prompt';
import { promptCheckpointBoundary } from './prompt-checkpoint';

describe.each(['gpt-2', 'qwen35'] as const)('native BPE pretokenizer %s', preTokenizer => {
  const filename = '/byte-bpe-token-boundaries.gguf';
  let core: ReturnType<typeof attachCore>;
  let model = 0n;
  let vocab = 0n;

  beforeAll(async () => {
    const folder = path.resolve('node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles/cpu-wasm32/test');
    const module = await createNativeModule({
      wasmBinary: await readFile(path.join(folder, 'core.wasm')),
      print() {},
      printErr() {},
    });
    core = attachCore({ module, callMode: 'direct' });
    await core.api.llama_backend_init();
    core.module.FS.writeFile(filename, createByteBpeMetadataGguf({ preTokenizer }));
    const source = core.utf8({ text: filename });
    const params = core.allocRecord({ name: 'llama_model_params' });
    using _cleanup = {
      [Symbol.dispose]() {
        core.free({ pointer: params });
        core.free({ pointer: source });
      },
    };
    await core.api.llama_model_default_params(params);
    core.setField({ name: 'llama_model_params', pointer: params, field: 'vocab_only', value: 1 });
    core.setField({ name: 'llama_model_params', pointer: params, field: 'n_gpu_layers', value: 0 });
    model = await core.api.llama_model_load_from_file(source, params);
    expect(model).not.toBe(0n);
    vocab = await core.api.llama_model_get_vocab(model);
    expect(await core.api.llama_vocab_type(vocab)).toBe(core.constant({ name: 'LLAMA_VOCAB_TYPE_BPE' }));
    expect(await core.api.llama_vocab_n_tokens(vocab)).toBe(260);
  });

  afterAll(async () => {
    if (!core) {
      return;
    }
    try {
      if (model !== 0n) {
        await core.api.llama_model_free(model);
      }
    } finally {
      if (core.module.FS.analyzePath(filename, false).exists) {
        core.module.FS.unlink(filename);
      }
      await core.api.llama_backend_free();
    }
  });

  async function nativeTokens({ text, parseSpecial }: { text: string, parseSpecial: boolean }): Promise<number[]> {
    const source = core.utf8({ text });
    using _source = {
      [Symbol.dispose]() {
        core.free({ pointer: source });
      },
    };
    const result = await tokenizePrompt({
      core,
      vocab,
      prompt: source,
      promptBytes: new TextEncoder().encode(text).length,
      contextTokens: 4096,
      addSpecial: false,
      parseSpecial,
      onTokenize: () => {},
    });
    using _result = {
      [Symbol.dispose]() {
        core.free({ pointer: result.pointer });
      },
    };
    return result.tokens;
  }

  async function preparedPrompt({ parts }: { parts: ChatPromptPart[] }) {
    const encoded = encodeChatPrompt({ parts });
    const prompt = core.alloc({ bytes: Math.max(1, encoded.data.length) });
    core.bytes({ pointer: prompt, length: encoded.data.length }).set(encoded.data);
    let transferred = false;
    try {
      const result = await tokenizeChatPrompt({ core, vocab, prompt, parts: encoded.parts, contextTokens: 4096, onTokenize: () => {} });
      transferred = true;
      return {
        ...result,
        prompt,
        text: parts.map(part => part.text).join(''),
        [Symbol.dispose]() {
          try {
            core.free({ pointer: result.pointer });
          } finally {
            core.free({ pointer: prompt });
          }
        },
      };
    } finally {
      if (!transferred) {
        core.free({ pointer: prompt });
      }
    }
  }

  describe('prompt boundaries with a real native byte-level BPE vocabulary', () => {
    it('joins an ordinary whitespace merge that separate native span calls lose', async () => {
      const whole = await nativeTokens({ text: 'hello \n', parseSpecial: false });
      const oldSegments = [...await nativeTokens({ text: 'hello ', parseSpecial: false }), ...await nativeTokens({ text: '\n', parseSpecial: true })];
      expect(oldSegments).not.toEqual(whole);
      // The self-authored vocabulary puts its only merged token after the 256 bytes.
      expect(whole.at(-1)).toBe(259);
      using result = await preparedPrompt({ parts: [{ text: 'hello ', isInput: true }, { text: '\n', isInput: false }] });
      expect(result.tokens).toEqual(whole);
      expect(result.parts).toEqual([{ byteOffset: 0, byteLength: 7, parseSpecial: false, tokenOffset: 0, tokenCount: 6, addSpecial: false }]);
    });

    it('keeps trusted controls and identical literal input text distinct', async () => {
      using result = await preparedPrompt({ parts: [{ text: '<s>', isInput: false }, { text: '<s>hello ', isInput: true }, { text: '\n</s>', isInput: false }] });
      const ordinary = await nativeTokens({ text: '<s>hello \n', parseSpecial: false });
      expect(result.tokens).toEqual([1, ...ordinary, 2]);
      expect(result.tokens.filter(token => token === 1)).toHaveLength(1);
      expect(result.tokens.filter(token => token === 2)).toHaveLength(1);
      expect(result.tokens).toContain(259);
      expect(result.parts.map(part => part.parseSpecial)).toEqual([true, false, true]);
    });

    it('preserves Unicode and NUL bytes while allowing the final whitespace merge', async () => {
      const text = '日本語\0😀 \n';
      using result = await preparedPrompt({ parts: [{ text: '日本語\0😀 ', isInput: true }, { text: '\n', isInput: false }] });
      expect(result.tokens).toEqual(await nativeTokens({ text, parseSpecial: false }));
      expect(result.tokens.at(-1)).toBe(259);
      expect(Array.from(core.bytes({ pointer: result.prompt, length: new TextEncoder().encode(text).length }))).toEqual(Array.from(new TextEncoder().encode(text)));
    });

    it('uses canonical run metadata to checkpoint before the generation marker', async () => {
      const generationPrompt = '<s>assistant\n';
      using result = await preparedPrompt({ parts: [{ text: 'hello ', isInput: true }, { text: `\n${generationPrompt}`, isInput: false }] });
      const prefix = await nativeTokens({ text: 'hello \n', parseSpecial: false });
      const boundary = await promptCheckpointBoundary({
        core,
        vocab,
        prompt: result.text,
        promptPointer: result.prompt,
        generationPrompt,
        tokens: result.tokens,
        parts: result.parts,
        onTokenize: () => {},
      });
      expect(boundary).toBe(prefix.length);
      expect(result.tokens.slice(0, boundary)).toEqual(prefix);
    });

    it('places a checkpoint before a token that crosses the generation suffix boundary', async () => {
      using result = await preparedPrompt({ parts: [{ text: 'hello ', isInput: true }, { text: '\n<s>assistant\n', isInput: false }] });
      const prefix = await nativeTokens({ text: 'hello', parseSpecial: false });
      const boundary = await promptCheckpointBoundary({
        core,
        vocab,
        prompt: result.text,
        promptPointer: result.prompt,
        generationPrompt: '\n<s>assistant\n',
        tokens: result.tokens,
        parts: result.parts,
        onTokenize: () => {},
      });
      expect(boundary).toBe(prefix.length);
      expect(result.tokens.slice(0, boundary)).toEqual(prefix);
      expect(result.tokens[boundary]).toBe(259);
    });

    it('preserves a valid generated suffix as the exact prefix of a cold continuation', async () => {
      const initial = '<s>assistant\n';
      const generated = `\
hello 
</s>`;
      const cached = [...await nativeTokens({ text: initial, parseSpecial: true }), ...await nativeTokens({ text: generated, parseSpecial: true })];
      using continuation = await preparedPrompt({
        parts: [{ text: initial, isInput: false }, { text: 'hello ', isInput: true }, {
          text: `\

</s><s>tool
ok</s><s>assistant
`,
          isInput: false,
        }],
      });
      expect(continuation.tokens.slice(0, cached.length)).toEqual(cached);
      expect(continuation.tokens.length).toBeGreaterThan(cached.length);
    });
  });
});
